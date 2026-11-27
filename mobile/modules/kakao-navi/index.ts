/**
 * 카카오내비 길안내 (COR-003). 개발 빌드(iOS)에만 들어 있고, Expo Go·테스트에서는 없다 → null.
 * 없으면 부르는 쪽(links.ts)이 카카오맵 앱 길찾기로 대신 연다.
 */
import { requireOptionalNativeModule } from 'expo';

export type NaviEndReason = 'arrived' | 'closed' | `error:${string}`;

type StartOptions = {
  goalName: string;
  goalLat: number;
  goalLng: number;
  startLat: number;
  startLng: number;
  userKey: string;
};

type NativeKakaoNavi = {
  isReady(): boolean;
  start(opts: StartOptions): Promise<void>;
  addListener(event: 'onNaviEnded', cb: (e: { reason: NaviEndReason }) => void): { remove(): void };
};

const native = requireOptionalNativeModule<NativeKakaoNavi>('KakaoNavi');

/** 이 앱에서 카카오내비 길안내를 쓸 수 있는지 (모듈 + 키) */
export function kakaoNaviReady(): boolean {
  try {
    return !!native && native.isReady();
  } catch {
    return false;
  }
}

/** 카카오내비 화면을 전체 화면으로 연다. 길안내가 끝나면 onEnded */
export async function startKakaoNavi(
  opts: StartOptions,
  onEnded?: (reason: NaviEndReason) => void,
): Promise<void> {
  if (!native) throw new Error('카카오내비를 쓸 수 없는 빌드예요');
  const sub = native.addListener('onNaviEnded', (e) => {
    sub.remove();
    onEnded?.(e.reason);
  });
  try {
    await native.start(opts);
  } catch (e) {
    sub.remove();
    throw e;
  }
}
