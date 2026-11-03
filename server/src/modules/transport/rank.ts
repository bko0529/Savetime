// 추천 산출 순서 (SFR-098 v1.5) 중 반경 안 병원을 받은 뒤의 단계. DB 없이 도는 순수 함수라 규칙을 표로 시험할 수 있다.
// 요청 화면과 예비 추천이 같은 함수를 써서 같은 결과를 본다 (SFR-112).
import { MAX_RADIUS_KM } from '../../domain/geo.js';

const TOP = 5; // 추천 카드 (SFR-027)
const NO_BED_INFO_MAX = 3; // '병상 정보 없음 · 전화로 확인' 묶음

export interface BedPair {
  avail: number | null;
  total: number | null;
}

export interface Candidate {
  id: string;
  distanceKm: number;
  grade: number; // 1 대학병원급 · 2 종합병원급 · 3 일반 (부록 F)
  beds: { er: BedPair; icu: BedPair; or: BedPair } | null; // null = 병상 행 자체가 없음
  anomaly: boolean; // 가용 > 전체 (SFR-088, 수집기가 표시)
  excluded: boolean; // 이번 이송의 제외 병원 (SFR-086)
}

export interface Ranked<T extends Candidate> {
  items: (T & { rank: number })[];
  noBedInfo: T[];
  emptyGuide: 'expand_radius' | 'call_nearby' | null;
}

// 공공 데이터 미제공·수집 실패로 저장값이 하나도 없으면 '병상 정보 없음'
export function hasBedInfo(candidate: Candidate): boolean {
  const { beds } = candidate;
  if (!beds) return false;
  return [beds.er, beds.icu, beds.or].some((pair) => pair.avail !== null || pair.total !== null);
}

export function rankHospitals<T extends Candidate>(
  candidates: T[],
  { requestedGrade, radiusKm }: { requestedGrade: number | null; radiusKm: number },
): Ranked<T> {
  const byDistance = [...candidates].sort(
    (a, b) => a.distanceKm - b.distanceKm || Number(a.id) - Number(b.id),
  );
  const usable = byDistance.filter((c) => !c.excluded);

  // 병상 정보가 아예 없는 병원은 빼지 않고 따로 보여 준다 (SFR-098). 전화로 확인할 수 있게.
  const noBedInfo = usable.filter((c) => !hasBedInfo(c)).slice(0, NO_BED_INFO_MAX);

  // 응급실 빈 병상이 0개거나 비어 있으면(정보 없음 = 0개, SFR-089) 제외한다 (SFR-030)
  const passed = usable.filter((c) => hasBedInfo(c) && !c.anomaly && (c.beds?.er.avail ?? 0) > 0);

  // 등급을 골랐으면 그 등급 이상(숫자가 같거나 작음)을 먼저, 그 안에서 거리순 (SFR-162, D-128)
  const meetsGrade = (c: T) => requestedGrade === null || c.grade <= requestedGrade;
  const ordered = [...passed.filter(meetsGrade), ...passed.filter((c) => !meetsGrade(c))];

  const items = ordered.slice(0, TOP).map((c, i) => ({ ...c, rank: i + 1 }));
  // 후보가 0곳이면 반경을 넓힐지 묻고, 이미 40km면 전화 확인을 안내한다 (SFR-029)
  const emptyGuide =
    items.length > 0 ? null : radiusKm >= MAX_RADIUS_KM ? 'call_nearby' : 'expand_radius';

  return { items, noBedInfo, emptyGuide };
}
