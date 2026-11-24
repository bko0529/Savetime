'use client';

import { useQuery } from '@tanstack/react-query';
import { INCOMING_KEY, type HwIncoming } from '@/app/hospital/useIncoming';
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

// 우리 병원 병상 '가용/전체' (GET /hw/session). 요청이 없어도 '우리 병원' 칸에 쓴다
export type OurBeds = { er?: string | null; icu?: string | null; or?: string | null };

// 요청 상세 (SFR-118, H-02). 열 때마다 서버가 열람 기록을 남기므로(SFR-137)
// 창을 다시 누르거나 다른 창에서 돌아올 때 저절로 다시 받지 않는다. 요청이 바뀌었다는 알림이 올 때만 다시 받는다
export function RequestDetail({
  requestId,
  nowMs,
  beds = null,
  listEta = null,
}: {
  requestId: number;
  nowMs: number;
  onClose?: () => void;
  // 요청 상세에 병상이 없을 때 쓰는 근무 화면의 병상
  beds?: OurBeds | null;
  // 요청 목록의 최신 도착 예상. 상세는 열람 기록 때문에 다시 받지 않아서, 요청 직후 연 상세에는
  // 길찾기 전 추정값이 남는다. 목록은 request.eta 때마다 새로 받으므로 그 값을 쓴다
  listEta?: { etaMin?: number | null; etaSource?: 'straight' | 'route' } | null;
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

  // 도착 예상은 목록의 최신 값(길찾기 반영)을 우선 쓴다. 확정 뒤에는 도착 예정 목록 값이 따로 이긴다 (etaLine)
  const d =
    detail.data && listEta?.etaMin != null
      ? {
          ...detail.data,
          etaMin: listEta.etaMin,
          etaSource: listEta.etaSource ?? detail.data.etaSource,
        }
      : detail.data;
  const a = (d?.assessment ?? {}) as Assessment;
  const waiting = d?.status === 'waiting';
  const urgent = waiting && d?.respondUntil && isUrgent(d.respondUntil, nowMs);
  const titleBits = [fieldText(a, 'sex'), fieldText(a, 'ageBand'), a.chiefComplaint].filter(
    Boolean,
  );

  return (
    <section aria-label="요청 상세" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-muted-foreground">요청 상세</p>
          <h2 className="text-[28px] font-extrabold tracking-[-0.02em] break-words">
            <span className="tabular-nums">R-{requestId}</span>
            {titleBits.length > 0 && ` · ${titleBits.join(' · ')}`}
          </h2>
        </div>
        {d && (
          <span
            className={cn(
              'shrink-0 rounded-full border px-4 py-1.5 text-[16px] font-extrabold tabular-nums',
              waiting && d.respondUntil
                ? urgent
                  ? 'border-danger-line bg-danger-soft text-destructive'
                  : 'border-warning-strong/30 bg-warning-soft text-warning-strong'
                : 'border-line bg-surface',
            )}
          >
            {waiting && d.respondUntil
              ? `남은 ${remainingText(d.respondUntil, nowMs)}`
              : (STATUS_TEXT[d.status ?? ''] ?? d.status)}
          </span>
        )}
      </div>
      {detail.isPending && <DetailGrid beds={beds} />}
      {/* 다시 받다가 실패하면(요청이 끝남 등) 예전 환자 정보는 남기지 않는다 (SER-014) */}
      {detail.isError ? (
        <DetailError error={detail.error} />
      ) : (
        d && <DetailBody detail={d} incomingItem={incomingItem} beds={beds} />
      )}
      {/* 응답 결과 문구(다른 PC 가 먼저 응답 등)는 요청이 끝나 상세가 닫혀도 남아 있어야 해서 본문 밖에 둔다 */}
      {d && (
        <RequestActions
          requestId={requestId}
          version={d.version ?? 1}
          canAnswer={
            !detail.isError &&
            d.status === 'waiting' &&
            !!d.respondUntil &&
            Date.parse(d.respondUntil) > nowMs
          }
          canCancelApproval={
            !detail.isError && (d.status === 'approved' || d.status === 'confirmed')
          }
          overApprovalHint={
            waiting
              ? { validApprovals: d.validApprovals ?? 0, erBeds: d.ourHospital?.beds?.er ?? null }
              : null
          }
        />
      )}
      {/* 추가 메모: 우리 병원으로 확정된 요청에 한 번만 (SFR-140) */}
      {d && !detail.isError && d.status === 'confirmed' && (
        <ExtraMemoButton requestId={requestId} version={d.version ?? 1} used={!!d.extraMemo} />
      )}
    </section>
  );
}

// 요청을 고르지 않았거나 아직 없을 때도 칸 모양은 그대로 둔다. 환자 값 자리는 '—',
// 우리 병원 병상은 지금 값을 보여 준다. 승인·거절 자리에는 무엇을 하는 곳인지 안내만 둔다
export function EmptyRequestDetail({ beds = null }: { beds?: OurBeds | null }) {
  return (
    <section aria-label="요청 상세" className="flex flex-col gap-4">
      <div>
        <p className="text-[14px] font-semibold text-muted-foreground">요청 상세</p>
        <h2 className="text-[28px] font-extrabold tracking-[-0.02em] text-muted-foreground">
          새 요청을 기다리는 중
        </h2>
      </div>
      <DetailGrid beds={beds} />
      <div className="rounded-[16px] border-2 border-dashed border-line bg-card px-6 py-6 text-center">
        <p className="text-[18px] font-bold">요청이 오면 여기서 승인·거절해요</p>
        <p className="mt-1 text-[15px] text-muted-foreground">
          승인할 때 메모(예: 3번 출입구로 오세요)를 함께 보낼 수 있어요
        </p>
      </div>
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
  if (incomingItem) return etaText(incomingItem).replace(/^도착 예상 /, '');
  // 목록을 아직 못 받았는데 이미 도착한 건이면 예전 예상 시간을 보여 주지 않는다
  if (detail.status === 'arrived') return null;
  if (detail.etaMin == null) return null;
  const estimated = detail.etaSource === 'straight';
  return `${estimated ? '약 ' : ''}${detail.etaMin}분${estimated ? ' (추정)' : ''}`;
}

const cardClass =
  'flex min-w-0 flex-col rounded-[16px] bg-card px-5 py-4 shadow-[0_4px_16px_rgba(15,23,42,0.06)]';

function CardTitle({ children }: { children: string }) {
  return (
    <h3 className="mb-2 flex items-center gap-2 text-[17px] font-extrabold">
      <span aria-hidden className="h-4 w-[3px] rounded-full bg-destructive" />
      {children}
    </h3>
  );
}

function Row({ label, value, warn }: { label: string; value: string | null; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-line py-2 last:border-0">
      <dt className="shrink-0 text-[15px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'text-right text-[16px] font-bold break-words tabular-nums',
          !value && 'font-normal text-muted-foreground',
          warn && 'text-destructive',
        )}
        data-abnormal={warn || undefined}
      >
        {value ? (warn ? `⚠ ${value}` : value) : '—'}
      </dd>
    </div>
  );
}

// 환자 평가 정보 · 우리 병원 두 칸. 요청이 없으면(detail 없음) 같은 칸에 '—' 만 보인다
function DetailGrid({
  detail,
  incomingItem,
  beds: fallbackBeds = null,
}: {
  detail?: Detail;
  incomingItem?: HwIncoming;
  beds?: OurBeds | null;
}) {
  const a = (detail?.assessment ?? {}) as Assessment;
  const abnormal = new Set(detail?.abnormalFields ?? []);
  const t = (f: keyof Assessment) => (detail ? fieldText(a, f) : null);
  const join = (...v: (string | null)[]) =>
    v.some(Boolean) ? v.map((x) => x ?? '—').join(' · ') : null;
  const pain = detail
    ? [
        fieldText(a, 'painSite'),
        a.painScore != null ? `${a.painScore}/10` : null,
        fieldText(a, 'onset'),
      ]
        .filter(Boolean)
        .join(' · ') || null
    : null;
  const beds = detail?.ourHospital?.beds ?? fallbackBeds;
  const cap = detail?.ourHospital?.capability;
  const eta = detail ? etaLine(detail, incomingItem) : null;
  // 기본 칸 말고 값이 있을 때만 보이는 칸
  const extra = (['temp', 'glucose', 'history', 'traumaCause'] as const).filter((f) => t(f));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className={cardClass}>
        <CardTitle>환자 평가 정보</CardTitle>
        <dl>
          <Row label="의식" value={t('consciousness')} warn={abnormal.has('consciousness')} />
          <Row label="혈압" value={t('bp')} warn={abnormal.has('bp')} />
          <Row
            label="맥박 · 호흡"
            value={join(t('pulse'), t('resp'))}
            warn={abnormal.has('pulse') || abnormal.has('resp')}
          />
          <Row label="산소포화도" value={t('spo2')} warn={abnormal.has('spo2')} />
          <Row label="통증" value={pain} warn={abnormal.has('painScore')} />
          <Row label="외상" value={t('trauma')} warn={abnormal.has('trauma')} />
          <Row label="KTAS" value={detail ? (t('ktas') ?? '미입력') : null} />
          {extra.map((f) => (
            <Row key={f} label={FIELD_LABEL[f] ?? f} value={t(f)} warn={abnormal.has(f)} />
          ))}
        </dl>
      </div>
      <div className={cardClass}>
        <CardTitle>우리 병원</CardTitle>
        <dl>
          {cap?.name && (
            <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-line py-2">
              <dt className="text-[15px] text-muted-foreground">[{cap.name}]</dt>
              <dd
                className={cn(
                  'text-[16px] font-extrabold',
                  cap.available ? 'text-success-strong' : 'text-destructive',
                )}
              >
                {cap.available ? '가능 ✓' : '불가'}
              </dd>
            </div>
          )}
          <Row label="응급실" value={beds?.er ?? null} />
          <Row label="수술실" value={beds?.or ?? null} />
          <Row label="중환자실" value={beds?.icu ?? null} />
          <Row label="도착 예상" value={eta} />
        </dl>
      </div>
    </div>
  );
}

function DetailBody({
  detail,
  incomingItem,
  beds,
}: {
  detail: Detail;
  incomingItem: HwIncoming | undefined;
  beds: OurBeds | null;
}) {
  return (
    <>
      <DetailGrid detail={detail} incomingItem={incomingItem} beds={beds} />
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
