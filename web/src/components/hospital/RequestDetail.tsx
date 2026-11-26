'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { INCOMING_KEY, type HwIncoming } from '@/app/hospital/useIncoming';
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
import { ExtraMemoButton } from './ExtraMemoButton';
import { etaText } from './IncomingList';
import { RequestActions } from './RequestActions';

type Detail =
  ApiPaths['/hw/requests/{requestId}']['get']['responses'][200]['content']['application/json'];
type IncomingList =
  ApiPaths['/hw/incoming']['get']['responses'][200]['content']['application/json'];

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
  // 확정 뒤 도착 예상(내비 남은 시간)·도착 시각은 도착 예정 목록이 이벤트마다 새로 받는다.
  // 상세는 열람 기록 때문에 다시 받지 않으므로(위) 그 목록 값을 같이 읽어 같은 시간을 보여 준다.
  // 여기서는 받지 않고(enabled: false) 도착 예정 목록이 받아 둔 값만 읽는다
  const incoming = useQuery({
    queryKey: INCOMING_KEY,
    queryFn: () => apiFetch<IncomingList>('/hw/incoming'),
    enabled: false,
  });
  const incomingItem = incoming.data?.items?.find((i) => i.id === requestId);

  return (
    <section
      aria-label="요청 상세"
      className="tile flex flex-col gap-5 p-6 shadow-[var(--shadow-lift)]"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span aria-hidden className="text-sm font-bold text-muted-foreground">
            요청 상세
          </span>
          <h2 className="text-3xl font-extrabold tracking-tight">요청 R-{requestId}</h2>
        </div>
        <Button variant="outline" onClick={onClose}>
          닫기
        </Button>
      </div>
      {detail.isPending && <p className="text-xl">불러오는 중…</p>}
      {/* 다시 받다가 실패하면(요청이 끝남 등) 예전 환자 정보는 남기지 않는다 (SER-014) */}
      {detail.isError ? (
        <DetailError error={detail.error} />
      ) : (
        detail.data && <DetailBody detail={detail.data} incomingItem={incomingItem} nowMs={nowMs} />
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
          canCancelApproval={
            !detail.isError &&
            (detail.data.status === 'approved' || detail.data.status === 'confirmed')
          }
        />
      )}
      {/* 추가 메모: 우리 병원으로 확정된 요청에 한 번만 (SFR-140) */}
      {detail.data && !detail.isError && detail.data.status === 'confirmed' && (
        <ExtraMemoButton
          requestId={requestId}
          version={detail.data.version ?? 1}
          used={!!detail.data.extraMemo}
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

// 요청 단계(대기·승인)에는 요청 때 계산한 값(직선거리면 '약 n분 (추정)'),
// 우리 병원으로 확정된 뒤에는 도착 예정 목록의 최신 값(내비 남은 시간·도착 시각)을 쓴다
function etaLine(detail: Detail, incomingItem: HwIncoming | undefined): string | null {
  if (incomingItem) return etaText(incomingItem);
  // 목록을 아직 못 받았는데 이미 도착한 건이면 예전 예상 시간을 보여 주지 않는다
  if (detail.status === 'arrived') return null;
  if (detail.etaMin == null) return null;
  const estimated = detail.etaSource === 'straight';
  return `도착 예상 ${estimated ? '약 ' : ''}${detail.etaMin}분${estimated ? ' (추정)' : ''}`;
}

// 글이 길어질 수 있는 항목은 한 줄을 다 쓴다 (좁은 칸에서 한 글자씩 줄바꿈되지 않게)
const WIDE_FIELDS = new Set<keyof Assessment>(['painSite', 'onset', 'traumaCause', 'history']);

function InfoTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-surface px-3 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-lg font-bold">{children}</span>
    </div>
  );
}

function DetailBody({
  detail,
  incomingItem,
  nowMs,
}: {
  detail: Detail;
  incomingItem: HwIncoming | undefined;
  nowMs: number;
}) {
  const eta = etaLine(detail, incomingItem);
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
      {/* 상태·남은 시간·도착을 작은 칸 3개로: 한눈에 '지금 뭘 해야 하는지'가 보이게 */}
      <div className="grid grid-cols-3 gap-2">
        <InfoTile label="상태">{STATUS_TEXT[detail.status ?? ''] ?? detail.status}</InfoTile>
        {waiting && detail.respondUntil && (
          <InfoTile label="응답 시간">
            <span className={cn('tabular-nums', urgent && 'font-extrabold text-destructive')}>
              남은 시간 {remainingText(detail.respondUntil, nowMs)}
            </span>
          </InfoTile>
        )}
        {eta && (
          <InfoTile label="도착">
            <span>{eta}</span>
          </InfoTile>
        )}
      </div>

      <p className="text-3xl font-extrabold">{a.chiefComplaint}</p>

      {/* 평가 항목을 칸(타일)으로. 정상 범위 밖 값은 빨간 칸 + 빨간 글자 + ⚠ (색만으로 구분하지 않게).
          위급도 판정은 하지 않는다 (D-38) */}
      <dl className="grid grid-cols-3 gap-2">
        {rows.map(({ field, text }) => {
          const bad = abnormal.has(field);
          return (
            <div
              key={field}
              className={cn(
                'flex flex-col gap-0.5 rounded-xl px-3 py-2.5',
                WIDE_FIELDS.has(field) && 'col-span-3',
                bad ? 'border border-destructive/30 bg-destructive/10' : 'bg-surface',
              )}
            >
              <dt className={cn('text-sm', bad ? 'text-destructive' : 'text-muted-foreground')}>
                {FIELD_LABEL[field]}
              </dt>
              <dd
                className={cn('text-lg font-bold break-keep', bad && 'text-destructive')}
                data-abnormal={bad || undefined}
              >
                {bad ? `⚠ ${text}` : text}
              </dd>
            </div>
          );
        })}
      </dl>

      <p className="rounded-xl bg-surface px-4 py-3 text-lg">
        <span className="font-bold">우리 병원</span>: 응급실 {beds?.er ?? '정보 없음'} · 수술실{' '}
        {beds?.or ?? '정보 없음'} · 중환자실 {beds?.icu ?? '정보 없음'}
      </p>

      {(detail.status === 'approved' || detail.status === 'confirmed') && (
        <p className="text-xl">
          {detail.respondedBy} 님이 승인함{detail.memo ? ` · 메모: ${detail.memo}` : ''}
        </p>
      )}
      {/* 한 번 보낸 추가 메모는 버튼 대신 내용을 보여 준다 (SFR-140) */}
      {detail.extraMemo && <p className="text-xl font-bold">추가 메모: {detail.extraMemo}</p>}
    </>
  );
}
