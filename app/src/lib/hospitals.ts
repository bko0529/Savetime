/** 병원 정보 모양. 값은 서버(추천·병원 상세 API)에서 받아 engine.ts 가 채운다 */
export type Bed = [number, number]; // [가용, 전체]
export type Cap = { name: string; available: boolean };

export type Hospital = {
  id: string;
  name: string;
  km: number;
  min: number;
  /** 응급실 병상 "가용/전체" (SFR-007). 값이 없으면 '정보 없음' (SFR-089) */
  er?: string;
  /** 중환자실 병상 */
  icu?: string;
  /** 수술실 병상 */
  or?: string;
  /** 진료과 (SFR-007) */
  depts: string[];
  /** 중증질환 진료가능 항목 — 공공 응급의료 데이터 표기 그대로 (SFR-007·011) */
  caps: Cap[];
  /** 응급실 직통 (SFR-007 연락처) */
  erPhone: string;
  /** 대표 전화 */
  mainPhone: string;
  /** 병상 데이터 기준 시각 (SFR-081) */
  bedsAt: string;
  grade: "대학병원급" | "종합병원급" | "일반 병원";
  phone: string;
  /** 진료가능 항목 수 (추천 목록은 개수만 준다. 상세를 열면 caps 로 채워진다) */
  capCount?: { available: number; total: number };
  lat?: number;
  lng?: number;
};

/** "3/12" → 3 (가용 병상 수). 병상 정보가 없으면 null (SFR-089) */
export function bedAvail(bed?: string): number | null {
  if (!bed) return null;
  const n = Number(bed.split("/")[0]);
  return Number.isFinite(n) ? n : null;
}

/** 중증질환 진료가능 항목 수 (SFR-002) */
export function capCount(h: Hospital) {
  if (h.caps.length === 0 && h.capCount) return h.capCount;
  return { available: h.caps.filter((c) => c.available).length, total: h.caps.length };
}

export const RESPONSE_LIMIT_SEC = 120;
export const APPROVAL_WINDOW_SEC = 300;
export const RADIUS_STEPS = [10, 20, 30, 40];
export const START_RADIUS = 20;
