'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import {
  FIELD_LABEL,
  fieldText,
  isUrgent,
  remainingText,
  type Assessment,
} from '@/lib/assessment/labels';
import { cn } from '@/lib/utils';
import { RequestActions } from './RequestActions';

type Detail =
  ApiPaths['/hw/requests/{requestId}']['get']['responses'][200]['content']['application/json'];

const STATUS_TEXT: Record<string, string> = {
  waiting: '응답 대기',
  approved: '승인함',
  confirmed: '우리 병원으로 확정',
  arrived: '도착',
  closed: '닫힘',
  expired: '응답 시간 지남',
  rejected: '거절함',
};

export const detailKey = (id: number) => ['hw', 'requests', 'detail', id] as const;

// 요청 상세 (SFR-118, H-02). 열 때마다 서버가 열람 기록을 남기므로(SFR-137)
// 창을 다시 누르거나 다른 창에서 돌아올 때 저절로 다시 받지 않는다. 요청이 바뀌었다는 알림이 올 때만 다시 받는다
export function RequestDetail({
  requestId,
  nowMs,
  onClose,
}: {
  requestId: number;
  nowMs: number;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: detailKey(requestId),
    queryFn: () => apiFetch<Detail>(`/hw/requests/${requestId}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <section
      aria-label="요청 상세"
      className="flex flex-col gap-5 rounded-lg border-2 border-foreground p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-3xl font-bold">요청 R-{requestId}</h2>
        <Button variant="outline" size="lg" onClick={onClose}>
          닫기
        </Button>
      </div>
      {detail.isPending && <p className="text-xl">불러오는 중…</p>}
      {/* 다시 받다가 실패하면(요청이 끝남 등) 예전 환자 정보는 남기지 않는다 (SER-014) */}
      {detail.isError ? (
        <DetailError error={detail.error} />
      ) : (
        detail.data && <DetailBody detail={detail.data} nowMs={nowMs} />
      )}
      {/* 응답 결과 문구(다른 PC 가 먼저 응답 등)는 요청이 끝나 상세가 닫혀도 남아 있어야 해서 본문 밖에 둔다 */}
      {detail.data && (
        <RequestActions
          requestId={requestId}
          version={detail.data.version ?? 1}
          canAnswer={
            !detail.isError &&
            detail.data.status === 'waiting' &&
            !!detail.data.respondUntil &&
            Date.parse(detail.data.respondUntil) > nowMs
          }
        />
      )}
    </section>
  );
}

function DetailError({ error }: { error: unknown }) {
  // 다른 PC 가 응답했거나 시간이 지나 끝난 요청은 환자 정보를 다시 볼 수 없다 (SER-014)
  if (error instanceof ApiError && error.code === 'REQUEST_CLOSED') {
    const status = (error.details as { status?: string } | null)?.status;
    return (
      <p role="alert" className="text-2xl font-bold">
        이미 끝난 요청이에요{status ? ` (${STATUS_TEXT[status] ?? status})` : ''}. 환자 정보는 볼 수
        없어요.
      </p>
    );
  }
  return (
    <p role="alert" className="text-xl font-bold text-destructive">
      {errorText(error)}
    </p>
  );
}

function DetailBody({ detail, nowMs }: { detail: Detail; nowMs: number }) {
  const a = (detail.assessment ?? {}) as Assessment;
  const abnormal = new Set(detail.abnormalFields ?? []);
  const waiting = detail.status === 'waiting';
  const urgent = waiting && detail.respondUntil && isUrgent(detail.respondUntil, nowMs);
  const beds = detail.ourHospital?.beds;
  const rows = (Object.keys(FIELD_LABEL) as (keyof Assessment)[])
    .map((field) => ({ field, text: fieldText(a, field) }))
    .filter((r): r is { field: keyof Assessment; text: string } => r.text !== null);

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 text-2xl">
        <span className="font-bold">{STATUS_TEXT[detail.status ?? ''] ?? detail.status}</span>
        {waiting && detail.respondUntil && (
          <span className={cn('tabular-nums', urgent && 'font-extrabold text-destructive')}>
            남은 시간 {remainingText(detail.respondUntil, nowMs)}
          </span>
        )}
        {detail.etaMin != null && (
          <span>
            도착 예상 {detail.etaSource === 'straight' ? '약 ' : ''}
            {detail.etaMin}분{detail.etaSource === 'straight' ? ' (추정)' : ''}
          </span>
        )}
      </div>

      <p className="text-3xl font-extrabold">{a.chiefComplaint}</p>

      {/* 정상 범위 밖 값은 빨간색 + ⚠ (색만으로 구분하지 않게). 위급도 판정은 하지 않는다 (D-38) */}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-2 text-xl">
        {rows.map(({ field, text }) => (
          <div key={field} className="contents">
            <dt className="text-muted-foreground">{FIELD_LABEL[field]}</dt>
            <dd
              className={cn(abnormal.has(field) && 'font-extrabold text-destructive')}
              data-abnormal={abnormal.has(field) || undefined}
            >
              {abnormal.has(field) ? `⚠ ${text}` : text}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-xl">
        <span className="font-bold">우리 병원</span>: 응급실 {beds?.er ?? '정보 없음'} · 수술실{' '}
        {beds?.or ?? '정보 없음'} · 중환자실 {beds?.icu ?? '정보 없음'}
      </p>

      {detail.status === 'approved' && (
        <p className="text-xl">
          {detail.respondedBy} 님이 승인함{detail.memo ? ` · 메모: ${detail.memo}` : ''}
        </p>
      )}
    </>
  );
}
