/**
 * 대원 위치. 시연 영상은 어디서 찍든 시연 병원(천안) 근처로 보이게 고정 위치를 쓸 수 있다.
 * - VITE_FIXED_LAT / VITE_FIXED_LNG 를 주면 그 위치를 쓰고, 이동 중 위치도 병원 쪽으로 흉내 낸다 (시연용)
 * - 없으면 기기 GPS. 못 가져오면 null (서버는 위치 없이도 주소로 받을 수 있지만 지금 화면은 위치를 쓴다)
 */
const env = import.meta.env as Record<string, string | undefined>;
const fixedLat = Number(env["VITE_FIXED_LAT"]);
const fixedLng = Number(env["VITE_FIXED_LNG"]);

export type LatLng = { lat: number; lng: number };

export const FIXED_LOCATION: LatLng | null =
  Number.isFinite(fixedLat) && Number.isFinite(fixedLng) && fixedLat !== 0 ? { lat: fixedLat, lng: fixedLng } : null;

export function currentLocation(timeoutMs = 4000): Promise<LatLng | null> {
  if (FIXED_LOCATION) return Promise.resolve(FIXED_LOCATION);
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10_000 },
    );
  });
}

/** 두 점 사이 거리 (m) */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** a 에서 b 쪽으로 m 미터 간 점 */
export function moveToward(a: LatLng, b: LatLng, m: number): LatLng {
  const d = distanceM(a, b);
  if (d <= m || d === 0) return b;
  const t = m / d;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}
