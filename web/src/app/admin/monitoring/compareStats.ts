import type { components } from '@/lib/api/schema';

type HospitalStat = components['schemas']['HospitalStat'];

// 비교할 지표. better: 값이 클수록 좋은지(응답률) 작을수록 좋은지(시간·취소율)
export type MetricKey =
  | 'responseRate'
  | 'avgResponseSec'
  | 'approvalCancelRate'
  | 'avgRequestToFirstApprovalSec'
  | 'avgRequestToDepartSec';

export const METRICS: {
  key: MetricKey;
  label: string;
  kind: 'rate' | 'sec';
  better: 'high' | 'low';
}[] = [
  { key: 'responseRate', label: '응답률', kind: 'rate', better: 'high' },
  { key: 'avgResponseSec', label: '평균 응답 시간', kind: 'sec', better: 'low' },
  { key: 'approvalCancelRate', label: '승인 취소율', kind: 'rate', better: 'low' },
  { key: 'avgRequestToFirstApprovalSec', label: '요청 → 첫 승인', kind: 'sec', better: 'low' },
  { key: 'avgRequestToDepartSec', label: '요청 → 출발', kind: 'sec', better: 'low' },
];

// 여러 병원의 평균. 요청이 많은 병원이 더 크게 반영되게 요청 수로 가중한다.
// 표본 부족(요청 10건 미만) 병원과 값이 없는 병원은 뺀다
export function weightedAverage(hospitals: HospitalStat[], key: MetricKey): number | null {
  let sum = 0;
  let weight = 0;
  for (const h of hospitals) {
    const v = h[key];
    const w = h.requests ?? 0;
    if (h.sampleTooSmall || v == null || w <= 0) continue;
    sum += v * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

// 평균을 낼 수 있는 병원 수 (표본 부족 제외)
export const comparableCount = (hospitals: HospitalStat[]) =>
  hospitals.filter((h) => !h.sampleTooSmall && (h.requests ?? 0) > 0).length;

export type Diff = { text: string; tone: 'good' | 'bad' | 'same' } | null;

// 이 병원 값과 비교 값의 차이. 비율은 %p, 시간은 초. 좋아졌으면 good(초록), 나빠졌으면 bad(빨강)
export function diffOf(
  metric: (typeof METRICS)[number],
  mine: number | null | undefined,
  other: number | null | undefined,
): Diff {
  if (mine == null || other == null) return null;
  const raw = metric.kind === 'rate' ? Math.round((mine - other) * 100) : Math.round(mine - other);
  if (raw === 0) return { text: '같음', tone: 'same' };
  const up = raw > 0;
  const good = metric.better === 'high' ? up : !up;
  const size = Math.abs(raw);
  const unit = metric.kind === 'rate' ? `${size}%p` : secText(size);
  return { text: `${up ? '▲' : '▼'} ${unit}`, tone: good ? 'good' : 'bad' };
}

export function secText(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분${s ? ` ${s}초` : ''}` : `${s}초`;
}

export function valueText(metric: (typeof METRICS)[number], v: number | null | undefined): string {
  if (v == null) return '—';
  return metric.kind === 'rate' ? `${Math.round(v * 100)}%` : secText(Math.round(v));
}
