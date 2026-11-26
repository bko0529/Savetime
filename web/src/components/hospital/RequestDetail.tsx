'use client';

import { useQuery } from '@tanstack/react-query';
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

// 상태·남은 시간·도착 예상 칸 (인계 시안: 연한 바탕, 위에 작은 이름표, 아래 큰 값)
const tileClass = 'flex min-w-0 flex-col gap-1 rounded-[12px] bg-surface px-4 py-3';
const tileLabel = 'text-[14px] font-semibold text-muted-foreground';
const tileValue = 'text-[22px] leading-tight font-extrabold tabular-nums break-words';

// '도착 예상 8분' → 이름표 '도착 예상' + 값 '8분'. 도착한 뒤('13:28 도착')는 이름표 '도착'
function etaTile(eta: string): { label: string; value: string } {
  const prefix = '도착 예상 ';
  return eta.startsWith(prefix)
    ? { label: '도착 예상', value: eta.slice(prefix.length) }
    : { label: '도착', value: eta };
}

// 병상 값 '6/20'(빈 병상/전체) → 큰 숫자 6 + 작은 /20
function BedTile({ label, value }: { label: string; value: string | null | undefined }) {
  const [avail, total] = value ? value.split('/') : [];
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-[12px] border border-line px-3 py-3">
      <span className="text-[16px] whitespace-nowrap text-muted-foreground">{label}</span>
      {value ? (
        <span className="tabular-nums">
          <span className="text-[22px] font-extrabold">{avail}</span>
          {total !== undefined && (
            <span className="text-[15px] font-semibold text-muted-foreground">/{total}</span>
          )}
        </span>
      ) : (
        <span className="text-[16px] font-bold">정보 없음</span>
      )}
    </div>
  );
}

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
      className="flex flex-col gap-4 rounded-[16px] border-2 border-foreground bg-card p-[24px]"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[15px] font-semibold text-muted-foreground">요청 상세</p>
          <h2 className="text-[30px] font-extrabold tracking-[-0.02em] tabular-nums">
            요청 R-{requestId}
          </h2>
        </div>
        <Button variant="outline" className="rounded-[10px]" onClick={onClose}>
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
      <p role="alert" className="rounded-[12px] bg-neutral-soft p-4 text-[22px] font-bold">
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
      <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-[10px]">
        <div className={tileClass}>
          <span className={tileLabel}>상태</span>
          <span className={tileValue}>{STATUS_TEXT[detail.status ?? ''] ?? detail.status}</span>
        </div>
        {waiting && detail.respondUntil && (
          // 30초 이하면 칸이 빨강 연한 바탕 + 빨간 숫자
          <div className={cn(tileClass, urgent && 'bg-danger-soft')}>
            <span className={tileLabel}>남은 시간</span>
            <span className={cn(tileValue, urgent && 'text-destructive')}>
              {remainingText(detail.respondUntil, nowMs)}
            </span>
          </div>
        )}
        {eta && (
          <div className={tileClass}>
            <span className={tileLabel}>{etaTile(eta).label}</span>
            <span className={tileValue}>{etaTile(eta).value}</span>
          </div>
        )}
      </div>

      <p className="text-[32px] leading-tight font-extrabold tracking-[-0.02em] break-words">
        {a.chiefComplaint}
      </p>

      {/* 정상 범위 밖 값은 빨간색 + ⚠ (색만으로 구분하지 않게). 위급도 판정은 하지 않는다 (D-38) */}
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {rows.map(({ field, text }) => (
          <div
            key={field}
            className={cn(
              'min-w-0 rounded-[10px] border border-line px-3 py-2',
              abnormal.has(field) && 'border-danger-line bg-danger-soft',
            )}
          >
            <dt className="text-[14px] text-muted-foreground">{FIELD_LABEL[field]}</dt>
            <dd
              className={cn(
                'text-[19px] font-semibold break-words',
                abnormal.has(field) && 'font-extrabold text-destructive',
              )}
              data-abnormal={abnormal.has(field) || undefined}
            >
              {abnormal.has(field) ? `⚠ ${text}` : text}
            </dd>
          </div>
        ))}
      </dl>

      {/* 우리 병원 병상: 응급실·수술실·중환자실 3칸 (이름표 왼쪽, 빈 병상 숫자 오른쪽) */}
      <section aria-label="우리 병원 병상" className="flex flex-col gap-2">
        <h3 className="text-[16px] font-extrabold">우리 병원 병상</h3>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2">
          <BedTile label="응급실" value={beds?.er} />
          <BedTile label="수술실" value={beds?.or} />
          <BedTile label="중환자실" value={beds?.icu} />
        </div>
      </section>

      {(detail.status === 'approved' || detail.status === 'confirmed') && (
        <p className="rounded-[12px] bg-success-soft px-4 py-3 text-[19px] font-bold text-success-strong">
          {detail.respondedBy} 님이 승인함{detail.memo ? ` · 메모: ${detail.memo}` : ''}
        </p>
      )}
      {/* 한 번 보낸 추가 메모는 버튼 대신 내용을 보여 준다 (SFR-140) */}
      {detail.extraMemo && (
        <p className="rounded-[12px] bg-info-soft px-4 py-3 text-[19px] font-bold text-info-strong">
          추가 메모: {detail.extraMemo}
        </p>
      )}
    </>
  );
}
