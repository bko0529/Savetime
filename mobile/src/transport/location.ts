/**
 * 대원 위치 (expo-location, '앱 사용 중' 권한).
 * 시연은 어디서 찍든 시연 병원(천안) 근처로 보이게 고정 위치를 쓸 수 있다:
 *   EXPO_PUBLIC_FIXED_LAT / EXPO_PUBLIC_FIXED_LNG 를 주면 그 위치를 쓰고, 이동 중 위치도 병원 쪽으로 흉내 낸다
 * 없으면 휴대폰 GPS. 못 가져오면 null.
 */
import * as Location from 'expo-location';

export type LatLng = { lat: number; lng: number };

const fixedLat = Number(process.env.EXPO_PUBLIC_FIXED_LAT);
const fixedLng = Number(process.env.EXPO_PUBLIC_FIXED_LNG);
export const FIXED_LOCATION: LatLng | null =
  Number.isFinite(fixedLat) && Number.isFinite(fixedLng) && fixedLat !== 0
    ? { lat: fixedLat, lng: fixedLng }
    : null;

/**
 * 주소로 정한 위치 (SFR-009): GPS 를 못 잡을 때 대원이 주소를 검색해 고른 기준 위치.
 * 휴대폰 메모리에만 두고(저장 안 함), 새 이송을 시작하면 지운다
 */
let manual: { at: LatLng; label: string } | null = null;
export const manualLocation = () => manual;
export function setManualLocation(m: { at: LatLng; label: string } | null) {
  manual = m;
}

/** 위치 한 번 읽기: 좌표 + 정확도(m) + 속도(km/h). 못 읽으면 null */
export type Fix = LatLng & { accuracyM: number | null; speedKmh: number | null; at: number };

export async function currentFix(timeoutMs = 4000): Promise<Fix | null> {
  if (FIXED_LOCATION) return { ...FIXED_LOCATION, accuracyM: 5, speedKmh: 0, at: Date.now() };
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const toFix = (p: Location.LocationObject): Fix => ({
      lat: p.coords.latitude,
      lng: p.coords.longitude,
      accuracyM: p.coords.accuracy ?? null,
      // 휴대폰은 m/s 로 주고, 모르면 음수·null
      speedKmh: p.coords.speed !== null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : null,
      at: p.timestamp,
    });
    // 10초 안에 잡은 위치가 있으면 그걸 쓰고(빠름), 없으면 새로 잡는다
    const last = await Location.getLastKnownPositionAsync({ maxAge: 10_000 });
    if (last) return toFix(last);
    const p = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    return p ? toFix(p) : null;
  } catch {
    return null;
  }
}

/** 요청·추천 기준 위치: GPS → (못 잡으면) 주소로 정한 위치 → null */
export async function currentLocation(timeoutMs = 4000): Promise<LatLng | null> {
  const f = await currentFix(timeoutMs);
  if (f) return { lat: f.lat, lng: f.lng };
  return manual?.at ?? null;
}

/**
 * 도착 버튼 판정 (SFR-038): 입구까지 거리 − GPS 오차 ≤ 30m 이고 시속 10km 이하.
 * 속도를 모르면(null) 멈춘 것으로 보지 않는다
 */
export const ARRIVE_M = 30;
export const ARRIVE_MAX_KMH = 10;
export function nearEntrance(distM: number, accuracyM: number | null, speedKmh: number | null) {
  return distM - (accuracyM ?? 0) <= ARRIVE_M && speedKmh !== null && speedKmh <= ARRIVE_MAX_KMH;
}

/** 위치 이상치 (SFR-040): 직전 좌표에서 초속 60m(시속 약 216km)를 넘게 움직였다면 도착 판정에 쓰지 않는다 */
export const OUTLIER_MPS = 60;
export function isOutlier(prev: Fix | null, next: Fix) {
  if (!prev) return false;
  const sec = (next.at - prev.at) / 1000;
  if (sec <= 0) return false;
  return distanceM(prev, next) / sec > OUTLIER_MPS;
}

/** 두 점 사이 거리 (m) */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** a 에서 b 쪽으로 m 미터 간 점 */
export function moveToward(a: LatLng, b: LatLng, m: number): LatLng {
  const d = distanceM(a, b);
  if (d <= m || d === 0) return b;
  const t = m / d;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}
