import { NextResponse, type NextRequest } from 'next/server';
import { decideRoute, parseAppRole } from '@/lib/appRole';

// proxy는 요청마다 서버에서 실행되므로 APP_ROLE을 빌드 때가 아니라 실행 때 읽는다.
// 그래서 이미지 하나로 병원 서버·관리자 서버를 모두 띄울 수 있다.
export function proxy(request: NextRequest) {
  const role = parseAppRole(process.env.APP_ROLE);
  const decision = decideRoute(role, request.nextUrl.pathname);

  if (decision.type === 'redirect') {
    return NextResponse.redirect(new URL(decision.to, request.url));
  }
  if (decision.type === 'notFound') {
    return new NextResponse('페이지를 찾을 수 없어요', { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  // 정적 파일(JS·CSS·이미지)은 검사하지 않는다
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
