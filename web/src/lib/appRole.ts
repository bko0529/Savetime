// 같은 Docker 이미지를 APP_ROLE 값만 바꿔 병원용·관리자용 서버로 띄운다 (COR-008, T-11).
// 관리자 화면이 병원 서버에서 열리면 안 되므로, 켜지지 않은 쪽 경로는 "없는 페이지(404)"로 취급한다.

export type AppRole = 'hospital' | 'admin';

// 값이 비었거나 오타면 권한이 약한 병원 쪽으로 둔다. 실수로 관리자 화면이 열리는 것보다 안전하다.
export function parseAppRole(value: string | undefined): AppRole {
  return value === 'admin' ? 'admin' : 'hospital';
}

export function homePath(role: AppRole): string {
  return role === 'admin' ? '/admin' : '/hospital';
}

export type RouteDecision =
  { type: 'allow' } | { type: 'redirect'; to: string } | { type: 'notFound' };

// '/admin/x'는 맞지만 '/administrator'는 다른 경로라서 글자 단위가 아니라 경로 조각 단위로 비교한다.
function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function decideRoute(role: AppRole, pathname: string): RouteDecision {
  if (pathname === '/') return { type: 'redirect', to: homePath(role) };

  const otherRole: AppRole = role === 'admin' ? 'hospital' : 'admin';
  if (isUnder(pathname, homePath(otherRole))) return { type: 'notFound' };

  return { type: 'allow' };
}
