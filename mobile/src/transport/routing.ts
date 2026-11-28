/**
 * 이송 상태 → 있어야 할 화면 (Lovable app-gate 의 '이송 건 상태 → 화면' 그대로).
 * 모든 이송 화면을 만들었다. 단계가 늘면 READY_SCREENS 에 더한다.
 */
import type { Href } from 'expo-router';
import type { TransportStatus } from './types';

/** 지금 만들어 둔 이송 화면 (단계가 늘면 여기에 더한다) */
export const READY_SCREENS = new Set<string>(['/request', '/call', '/transport', '/navi', '/log']);

/**
 * navHere: 이 폰이 길 안내를 맡거나 병원을 확정한 폰이면, 이동 중에는 이송 화면 대신
 * 앱 안 길 안내 페이지(카카오내비)로 바로 간다 (확정 → 내 위치에서 병원까지 바로 안내)
 */
export function routeForStatus(
  status: TransportStatus | null,
  phoneTarget: string | null,
  navHere = false,
): Href | null {
  const want =
    status === 'requesting' || status === 'fallback'
      ? '/request'
      : status === 'phone_check' && phoneTarget
        ? `/call/${phoneTarget}`
        : status === 'moving'
          ? navHere
            ? '/navi'
            : '/transport'
          : status === 'arrived'
            ? '/log'
            : null;
  if (!want) return null;
  const base = want.startsWith('/call/') ? '/call' : want;
  return READY_SCREENS.has(base) ? (want as Href) : null;
}
