// 좌표 계산 공용 (수집기·추천이 같은 기준을 쓴다)

// 대한민국 영역 (SFR-087). 값이 있어도 0처럼 이 밖이면 좌표가 없는 것으로 본다.
export function isInKorea(lat: number | undefined, lng: number | undefined): boolean {
  return (
    lat !== undefined && lng !== undefined && lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132
  );
}

// 앱이 고를 수 있는 검색 반경 (SFR-012). 넓히기는 한 단계씩 (SFR-029)
export const RADIUS_KM = [10, 20, 30, 40] as const;
export type RadiusKm = (typeof RADIUS_KM)[number];
export const MAX_RADIUS_KM: RadiusKm = 40;
