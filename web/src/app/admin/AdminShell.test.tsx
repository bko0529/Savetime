import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { fakeServer } from '@/testing/render';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider, useAdminAuth } from './AdminAuth';
import { AdminHome } from './AdminHome';
import { ComingSoon } from './AdminShell';

const replace = vi.fn();
let pathname = '/admin';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}));

// 로그인한 상태를 만든다 (토큰은 메모리에만 있으니 화면을 그리기 전에 넣어 준다).
// 한 번 그린 뒤에는 계속 그려서, 로그아웃했을 때 화면이 로그인 화면으로 보내는지 볼 수 있게 한다
function SignedIn({ children }: { children: ReactNode }) {
  const { signIn } = useAdminAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    signIn({ accessToken: 'a', refreshToken: 'r' });
    setReady(true);
  }, [signIn]);
  return ready ? children : null;
}

function renderAdmin(ui: ReactNode, { signedIn = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminAuthProvider>{signedIn ? <SignedIn>{ui}</SignedIn> : ui}</AdminAuthProvider>
    </QueryClientProvider>,
  );
}

let server: ReturnType<typeof fakeServer>;
beforeEach(() => {
  replace.mockClear();
  pathname = '/admin';
  // 상단 바가 읽지 않은 알림 개수를 묻는다 (SFR-100)
  server = fakeServer({
    'GET /admin/notifications?limit=1': {
      status: 200,
      body: { items: [], nextCursor: null, unread: 3 },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('상단 알림 개수 (SFR-100)', () => {
  it('읽지 않은 알림 개수를 보여 주고, 누르면 모니터링 알림 목록으로 간다', async () => {
    renderAdmin(<AdminHome />);
    const badge = await screen.findByRole('link', { name: '읽지 않은 알림 3개' });
    expect(badge.textContent).toBe('알림 3');
    expect(badge.getAttribute('href')).toBe('/admin/monitoring#notifications');
    expect(server.callsTo('GET /admin/notifications?limit=1')).toHaveLength(1);
  });
});

describe('관리자 메뉴 (SFR-082)', () => {
  it('로그인하면 계정·모니터링·병원 관리 메뉴 3개가 보인다', async () => {
    renderAdmin(<AdminHome />);
    const nav = await screen.findByRole('navigation', { name: '관리자 메뉴' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['계정', '/admin/accounts'],
      ['모니터링', '/admin/monitoring'],
      ['병원 관리', '/admin/hospitals'],
    ]);
    // 첫 화면 카드에도 같은 3개
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('지금 보는 메뉴를 표시한다', async () => {
    pathname = '/admin/hospitals';
    renderAdmin(<ComingSoon title="병원 관리" items={[]} />);
    const nav = await screen.findByRole('navigation', { name: '관리자 메뉴' });
    expect(within(nav).getByRole('link', { name: '병원 관리' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: '계정' }).getAttribute('aria-current')).toBeNull();
  });

  it('로그인 안 했으면 아무것도 보여 주지 않고 로그인 화면으로 보낸다', () => {
    renderAdmin(<AdminHome />, { signedIn: false });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/admin/login');
  });

  it('로그아웃하면 로그인 화면으로 간다', async () => {
    renderAdmin(<AdminHome />);
    fireEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    expect(replace).toHaveBeenCalledWith('/admin/login');
  });
});
