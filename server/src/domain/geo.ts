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

// 두 좌표 사이 직선거리(m, 하버사인). 위치 기록은 5초 간격이라 구간을 직선으로 이어도 실제 거리와 거의 같다
export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
