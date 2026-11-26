/**
 * 지금 상태에서 있어야 할 화면 (Lovable app-gate.tsx 와 같은 순서).
 * 업데이트 → 위치 동의 → 권한 → 로그인(·가입 신청) → 승인 대기 → 근무 시작(팀) → 앱
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
  /** 팀: loading = 서버에 묻는 중, started = 이 팀으로 '근무 시작'을 눌렀음 */
  duty?: { team: 'loading' | 'none' | 'joined'; started: boolean };
};

export type Screen =
  'loading' | 'update' | 'welcome' | 'permissions' | 'login' | 'pending' | 'duty' | 'home';

export function gateTarget(g: GateInput): Screen {
  if (versionBelow(g.appVersion, g.minAppVersion)) return 'update';
  if (g.consent === 'loading') return 'loading';
  if (g.consent !== 'agreed') return 'welcome';
  if (g.permissions.location === 'loading' || g.permissions.notify === 'loading') return 'loading';
  if (!permissionsDone(g.permissions)) return 'permissions';
  if (g.auth.status === 'loading') return 'loading';
  if (g.auth.status === 'signedOut') return 'login';
  // SFR-022: 승인 전에는 '승인 대기' 화면만 (반려·정지도 이 화면이 문구를 고름)
  if (g.auth.me.status !== 'approved') return 'pending';
  // SFR-113: 근무(팀)를 시작해야 이송 화면을 쓴다
  if (!g.duty || g.duty.team === 'loading') return 'loading';
  if (g.duty.team === 'none' || !g.duty.started) return 'duty';
  return 'home';
}

/** 가입 신청 화면을 열 수 있는지: 로그인 전이거나, 반려돼서 다시 신청할 때 (SFR-017·083) */
export function canSignup(g: GateInput, target = gateTarget(g)): boolean {
  if (target === 'login') return true;
  return target === 'pending' && g.auth.status === 'signedIn' && g.auth.me.status === 'rejected';
}
