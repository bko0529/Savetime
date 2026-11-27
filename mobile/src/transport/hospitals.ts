/** 병원 정보 모양 (Lovable hospitals.ts 그대로). 값은 서버(추천·병원 상세 API)에서 받아 engine.ts 가 채운다 */
export type Cap = { name: string; available: boolean };
export type Grade = '대학병원급' | '종합병원급' | '일반 병원' | null;

export type Hospital = {
  id: string;
  name: string;
  km: number;
  min: number;
  /** 응급실 병상 "가용/전체" (SFR-007). 값이 없으면 '정보 없음' (SFR-089) */
  er?: string;
  icu?: string;
  or?: string;
  /** 진료과 (SFR-007) */
  depts: string[];
  /** 중증질환 진료가능 항목 — 공공 응급의료 데이터 표기 그대로 (SFR-007·011) */
  caps: Cap[];
  erPhone: string;
  mainPhone: string;
  /** 병상 데이터 기준 시각 (SFR-081) */
  bedsAt: string;
  grade: Exclude<Grade, null>;
  phone: string;
  /** 진료가능 항목 수 (추천 목록은 개수만 준다. 상세를 열면 caps 로 채워진다) */
  capCount?: { available: number; total: number };
  lat?: number;
  lng?: number;
  /** 서버가 병상을 수집한 시각 = 화면의 '기준 HH:MM' (SFR-081) */
  collectedAt?: string | null;
  /** 수집한 지 10분이 지남 → '참고용 정보 · 기준 HH:MM' (SFR-081 ②) */
  stale?: boolean | null;
};

/** 데이터 상태 문구 (SFR-081): 최신이면 기준 시각만, 10분 지났거나 오프라인이면 '참고용 정보 · 기준 HH:MM' */
export function bedsLabel(h: Pick<Hospital, 'collectedAt' | 'stale' | 'bedsAt'>, offline = false) {
  const t = h.collectedAt ? hhmmOf(h.collectedAt) : h.bedsAt;
  if (!t) return '';
  return h.stale || offline ? `참고용 정보 · 기준 ${t}` : `기준 ${t}`;
}
function hhmmOf(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "3/12" → 3 (가용 병상 수). 병상 정보가 없으면 null (SFR-089) */
export function bedAvail(bed?: string): number | null {
  if (!bed) return null;
  const n = Number(bed.split('/')[0]);
  return Number.isFinite(n) ? n : null;
}

/** 중증질환 진료가능 항목 수 (SFR-002) */
export function capCount(h: Hospital) {
  if (h.caps.length === 0 && h.capCount) return h.capCount;
  return { available: h.caps.filter((c) => c.available).length, total: h.caps.length };
}

export const GRADE_NAME: Record<number, Exclude<Grade, null>> = {
  1: '대학병원급',
  2: '종합병원급',
  3: '일반 병원',
};
export const GRADE_NO: Record<Exclude<Grade, null>, 1 | 2 | 3> = {
  대학병원급: 1,
  종합병원급: 2,
  '일반 병원': 3,
};

export const RESPONSE_LIMIT_SEC = 120;
export const APPROVAL_WINDOW_SEC = 300;
export const RADIUS_STEPS = [10, 20, 30, 40];
export const START_RADIUS = 20;
