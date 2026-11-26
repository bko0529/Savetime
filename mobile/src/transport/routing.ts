/**
 * 이송 상태 → 있어야 할 화면 (Lovable app-gate 의 '이송 건 상태 → 화면' 그대로).
 * 일지 화면은 7단계에서 붙인다. 아직 없는 화면은 null (홈에 머묾).
 */
import type { Href } from 'expo-router';
import type { TransportStatus } from './types';

/** 지금 만들어 둔 이송 화면 (단계가 늘면 여기에 더한다) */
export const READY_SCREENS = new Set<string>(['/request', '/call', '/transport']);

export function routeForStatus(
  status: TransportStatus | null,
  phoneTarget: string | null,
): Href | null {
  const want =
    status === 'requesting' || status === 'fallback'
      ? '/request'
      : status === 'phone_check' && phoneTarget
        ? `/call/${phoneTarget}`
        : status === 'moving'
          ? '/transport'
          : status === 'arrived'
            ? '/log'
            : null;
  if (!want) return null;
  const base = want.startsWith('/call/') ? '/call' : want;
  return READY_SCREENS.has(base) ? (want as Href) : null;
}
