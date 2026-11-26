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

export async function currentLocation(timeoutMs = 4000): Promise<LatLng | null> {
  if (FIXED_LOCATION) return FIXED_LOCATION;
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return null;
    // 10초 안에 잡은 위치가 있으면 그걸 쓰고(빠름), 없으면 새로 잡는다
    const last = await Location.getLastKnownPositionAsync({ maxAge: 10_000 });
    if (last) return { lat: last.coords.latitude, lng: last.coords.longitude };
    const p = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    return p ? { lat: p.coords.latitude, lng: p.coords.longitude } : null;
  } catch {
    return null;
  }
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
