/**
 * 휴대폰의 다른 앱 열기: 전화(tel:) · 길 안내(카카오맵).
 * 앱 안 카카오 내비 SDK 는 9단계에서 붙인다. 그 전에는 카카오맵 앱 길찾기, 없으면 카카오맵 웹으로 연다.
 */
import { Linking } from 'react-native';
import type { LatLng } from './location';

export function callNumber(num: string | null | undefined) {
  const digits = (num ?? '').replace(/[^\d+]/g, '');
  if (digits) void Linking.openURL(`tel:${digits}`).catch(() => undefined);
}

/** 카카오맵 길찾기 주소 (앱 → 웹 순서) */
export function routeUrls(to: LatLng, name: string) {
  return {
    app: `kakaomap://route?ep=${to.lat},${to.lng}&by=CAR`,
    web: `https://map.kakao.com/link/to/${encodeURIComponent(name)},${to.lat},${to.lng}`,
  };
}

export async function openRoute(to: LatLng, name: string) {
  const u = routeUrls(to, name);
  try {
    await Linking.openURL(u.app);
  } catch {
    await Linking.openURL(u.web).catch(() => undefined);
  }
}
