'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { INCOMING_KEY, type HwIncoming } from '@/app/hospital/useIncoming';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { fieldText, isUrgent, remainingText, type Assessment } from '@/lib/assessment/labels';
import { cn } from '@/lib/utils';
import { AssessmentRows } from './AssessmentRows';
import { detailKey } from './detailKey';
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

// '도착 예상 8분' → 값 '8분'. 도착한 뒤('13:28 도착')는 이름표 '도착'
function etaRow(eta: string): { label: string; value: string } {
  const prefix = '도착 예상 ';
  return eta.startsWith(prefix)
    ? { label: '도착 예상', value: eta.slice(prefix.length) }
    : { label: '도착', value: eta };
}

// 카드 한 줄: 이름 왼쪽, 값 오른쪽 (시안의 '환자 평가 정보'·'우리 병원' 카드)
const rowClass =
  'flex items-baseline justify-between gap-4 border-b border-line-soft py-2.5 last:border-b-0';
const cardClass =
  'flex min-w-0 flex-col rounded-[16px] border border-line bg-card px-5 py-4 shadow-[var(--shadow-card)]';

function CardTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1 flex items-center gap-2 text-[17px] font-extrabold">
      <span aria-hidden className="h-4 w-[3px] rounded-full bg-destructive" />
      {children}
    </h3>
  );
}

export { detailKey };

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
    <section aria-label="요청 상세" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* 제목: 번호 · 성별 나이대 · 주 증상 (시안) */}
        <h2 className="min-w-0 text-[24px] leading-snug font-extrabold tracking-[-0.02em] break-words">
          {detail.data && !detail.isError
            ? titleText(detail.data, requestId)
            : `요청 R-${requestId}`}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {detail.data && !detail.isError && <RemainingChip detail={detail.data} nowMs={nowMs} />}
          <Button
            variant="outline"
            className="h-9 rounded-[10px] px-3 text-[15px]"
            onClick={onClose}
          >
            닫기
          </Button>
        </div>
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
          approvalHint={approvalHint(detail.data)}
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

// 제목: 'R-102 · 남 60대 · 두통' (값이 없으면 빼고 잇는다)
function titleText(detail: Detail, requestId: number): string {
  const a = (detail.assessment ?? {}) as Assessment;
  // 확인 불가는 '성별 X'·'나이 X' 로 짧게
  const sex = fieldText(a, 'sex');
  const age = fieldText(a, 'ageBand');
  const who = [sex === '확인 불가' ? '성별 X' : sex, age === '확인 불가' ? '나이 X' : age]
    .filter(Boolean)
    .join(' ');
  return [detail.label ?? `R-${requestId}`, who, a.chiefComplaint].filter(Boolean).join(' · ');
}

// 오른쪽 위 칩: 대기 중이면 '남은 1:40'(30초 이하 빨강), 아니면 상태
function RemainingChip({ detail, nowMs }: { detail: Detail; nowMs: number }) {
  if (detail.status === 'waiting' && detail.respondUntil) {
    const urgent = isUrgent(detail.respondUntil, nowMs);
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[16px] font-bold whitespace-nowrap',
          urgent
            ? 'border-danger-line bg-danger-soft text-danger-strong'
            : 'border-warning-strong/30 bg-warning-soft text-warning-strong',
        )}
      >
        남은 시간 :{' '}
        <span className={cn('tabular-nums', urgent && 'font-extrabold text-destructive')}>
          {remainingText(detail.respondUntil, nowMs)}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full border border-line bg-surface px-3 py-1 text-[16px] font-bold whitespace-nowrap">
      {STATUS_TEXT[detail.status ?? ''] ?? detail.status}
    </span>
  );
}

// 승인 전에 미리 보여 주는 안내: 지금 유효한 승인 수와 응급실 빈 병상 (병상 정보가 없으면 안 보여 줌)
function approvalHint(detail: Detail): string | null {
  const erAvail = Number(detail.ourHospital?.beds?.er?.split('/')[0]);
  if (detail.validApprovals == null || !Number.isFinite(erAvail)) return null;
  return `지금 유효한 승인 ${detail.validApprovals}건 · 응급실 병상 ${erAvail}개 (병상보다 많이 승인하면 확인을 한 번 더 받아요)`;
}

function DetailBody({
  detail,
  incomingItem,
}: {
  detail: Detail;
  incomingItem: HwIncoming | undefined;
  nowMs: number;
}) {
  const eta = etaLine(detail, incomingItem);
  const a = (detail.assessment ?? {}) as Assessment;
  const beds = detail.ourHospital?.beds;
  const capability = detail.ourHospital?.capability;
  // 확정 전 길찾기로 잰 시간이면 '(길찾기)'를 붙인다 (직선거리 추정은 이미 '(추정)')
  const etaShown = eta ? etaRow(eta) : null;
  const etaValue =
    etaShown && !incomingItem && detail.etaSource === 'route'
      ? `${etaShown.value} (길찾기)`
      : etaShown?.value;
  const bedRows = [
    ['응급실', beds?.er],
    ['수술실', beds?.or],
    ['중환자실', beds?.icu],
  ] as const;

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="환자 평가 정보" className={cardClass}>
          <CardTitle>환자 평가 정보</CardTitle>
          {/* 제목에 이미 있는 주 증상·성별·나이대는 뺀다. 확인 불가는 X, 이상 수치는 ⚠ 빨강 */}
          <AssessmentRows
            assessment={a}
            abnormalFields={detail.abnormalFields}
            skip={['sex', 'ageBand']}
          />
        </section>

        <section aria-label="우리 병원" className={cardClass}>
          <CardTitle>우리 병원</CardTitle>
          <dl className="flex flex-col">
            {capability?.name && (
              <div className={rowClass}>
                <dt className="text-[16px] text-muted-foreground">[{capability.name}]</dt>
                <dd
                  className={cn(
                    'text-[17px] font-extrabold',
                    capability.available ? 'text-success-strong' : 'text-destructive',
                  )}
                >
                  {capability.available ? '가능 ✓' : '불가'}
                </dd>
              </div>
            )}
            {bedRows.map(([label, value]) => (
              <div key={label} className={rowClass}>
                <dt className="text-[16px] text-muted-foreground">{label}</dt>
                <dd className="text-[17px] font-bold tabular-nums">
                  {value ? value.replace('/', ' / ') : '정보 없음'}
                </dd>
              </div>
            ))}
            {etaShown && (
              <div className={rowClass}>
                <dt className="text-[16px] text-muted-foreground">{etaShown.label}</dt>
                <dd className="text-[17px] font-bold tabular-nums">{etaValue}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>

      {(detail.status === 'approved' || detail.status === 'confirmed') && (
        <p className="rounded-[12px] bg-success-soft px-4 py-3 text-[18px] font-bold text-success-strong">
          {detail.respondedBy} 님이 승인함{detail.memo ? ` · 메모: ${detail.memo}` : ''}
        </p>
      )}
      {/* 한 번 보낸 추가 메모는 버튼 대신 내용을 보여 준다 (SFR-140) */}
      {detail.extraMemo && (
        <p className="rounded-[12px] bg-info-soft px-4 py-3 text-[18px] font-bold text-info-strong">
          추가 메모: {detail.extraMemo}
        </p>
      )}
    </>
  );
}
