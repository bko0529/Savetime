/**
 * 카카오내비 길안내 화면 칸 (COR-003). 앱 안 '길 안내' 페이지(app/navi.tsx)에 들어간다.
 * 개발 빌드(iOS)에만 들어 있고, Expo Go·테스트에서는 없다 → KakaoNaviView 가 null.
 */
import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

export type NaviTrip = {
  goalName: string;
  goalLat: number;
  goalLng: number;
  startLat: number;
  startLng: number;
  /** 대원 구분 값: 무작위 기기 ID (이름·전화번호를 넣지 않는다, SER-012) */
  userKey: string;
};
export type NaviEndReason = 'arrived' | 'closed';
export type NaviError = { stage: 'init' | 'route'; code: string; message: string };

type Ev<T> = { nativeEvent: T };
export type KakaoNaviViewProps = {
  trip: NaviTrip;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onReady?: () => void;
  onEnded?: (e: Ev<{ reason: NaviEndReason }>) => void;
  onError?: (e: Ev<NaviError>) => void;
};

const native = requireOptionalNativeModule<{ isReady(): boolean }>('KakaoNavi');

/** 이 앱에서 카카오내비를 쓸 수 있는지 (모듈 + 키) */
export function kakaoNaviReady(): boolean {
  try {
    return !!native && native.isReady();
  } catch {
    return false;
  }
}

/** 네이티브 화면 칸. 모듈이 없는 빌드에서는 null */
export const KakaoNaviView: ComponentType<KakaoNaviViewProps> | null = native
  ? requireNativeView<KakaoNaviViewProps>('KakaoNavi')
  : null;

/** 카카오 오류 코드를 대원이 읽을 수 있는 말로 */
export function naviErrorText(e: NaviError): string {
  if (e.code === 'NO_KEY') return '이 앱 빌드에 카카오내비 키가 없어요';
  if (e.stage === 'init')
    return `카카오내비 인증에 실패했어요 (${e.code}). 인터넷 연결을 확인해 주세요`;
  return `경로를 받지 못했어요 (${e.code}). 인터넷 연결을 확인하고 다시 시도해 주세요`;
}
