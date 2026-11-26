/**
 * 지금 상태에서 있어야 할 화면 (Lovable app-gate.tsx 와 같은 순서).
 * 업데이트 → 위치 동의 → 권한 → 로그인 → (승인 대기) → 앱
 * 화면 함수가 아니라 순수 함수라 테스트로 순서를 확인하기 쉽다.
 */
import type { Me } from './api/client';
import type { Consent } from './state/consent';
import { permissionsDone, type Perm } from './state/permissions';
import { versionBelow } from './state/config';

export type GateInput = {
  appVersion: string;
  minAppVersion: string;
  consent: Consent;
  permissions: { location: Perm; notify: Perm };
  auth: { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; me: Me };
};

export type Screen = 'loading' | 'update' | 'welcome' | 'permissions' | 'login' | 'home';

export function gateTarget(g: GateInput): Screen {
  if (versionBelow(g.appVersion, g.minAppVersion)) return 'update';
  if (g.consent === 'loading') return 'loading';
  if (g.consent !== 'agreed') return 'welcome';
  if (g.permissions.location === 'loading' || g.permissions.notify === 'loading') return 'loading';
  if (!permissionsDone(g.permissions)) return 'permissions';
  if (g.auth.status === 'loading') return 'loading';
  if (g.auth.status === 'signedOut') return 'login';
  // 승인 대기·반려는 home 이 me.status 로 문구를 고른다 (2단계에서 pending 화면으로 나눔)
  return 'home';
}
