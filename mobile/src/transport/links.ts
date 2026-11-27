/**
 * 전화(tel:) · 길 안내.
 * 길 안내는 앱 안 카카오내비(KNSDK-UI, 개발 빌드)가 먼저. 없거나(Expo Go) 실패하면
 * 카카오맵 앱 길찾기, 그것도 없으면 카카오맵 웹으로 연다 (COR-003 대체 경로)
 */
import { Linking } from 'react-native';
import { kakaoNaviReady, startKakaoNavi } from '../../modules/kakao-navi';
import { getDeviceId } from '../auth/storage';
import { currentLocation, type LatLng } from './location';

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

/** 카카오맵 앱 → 웹 순서로 길찾기 열기 */
async function openMapApp(to: LatLng, name: string) {
  const u = routeUrls(to, name);
  try {
    await Linking.openURL(u.app);
  } catch {
    await Linking.openURL(u.web).catch(() => undefined);
  }
}

/**
 * 길 안내 시작. 앱 안 카카오내비가 되면 그걸 전체 화면으로 띄우고, 안 되면 카카오맵.
 * 사용자 구분 값은 이 휴대폰의 무작위 기기 ID (이름·전화번호를 넣지 않는다, SER-012)
 */
export async function openRoute(to: LatLng, name: string) {
  if (kakaoNaviReady()) {
    try {
      const from = await currentLocation();
      if (from) {
        await startKakaoNavi({
          goalName: name,
          goalLat: to.lat,
          goalLng: to.lng,
          startLat: from.lat,
          startLng: from.lng,
          userKey: await getDeviceId(),
        });
        return;
      }
    } catch {
      /* 카카오내비를 못 띄우면 카카오맵으로 */
    }
  }
  await openMapApp(to, name);
}
