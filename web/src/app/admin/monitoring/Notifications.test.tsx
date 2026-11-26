import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from '../AdminAuth';
import { notificationHref, Notifications } from './Notifications';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  usePathname: () => '/admin/monitoring',
}));

function SignedIn({ children }: { children: ReactNode }) {
  const { signIn } = useAdminAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    signIn({ accessToken: 'admin-token', refreshToken: 'r' });
    setReady(true);
  }, [signIn]);
  return ready ? children : null;
}

function renderList(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminAuthProvider keepLogin={false}>
        <SignedIn>{ui}</SignedIn>
      </AdminAuthProvider>
    </QueryClientProvider>,
  );
}

const LIST = 'GET /admin/notifications?limit=30';
const item = (id: number, extra: object) => ({
  id,
  text: `알림 ${id}`,
  occurrences: 1,
  lastAt: '2026-11-26T12:00:00Z',
  read: false,
  refId: null,
  hospitalName: null,
  ...extra,
});
const page = (...items: object[]) => ({
  status: 200,
  body: { items, nextCursor: null, unread: items.length },
});

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('알림을 누르면 해당 화면으로', () => {
  it('가입 신청 → 그 신청 창, PC·이상 PC → 병원 관리의 등록 PC, 키 만료 → 병원 관리', () => {
    expect(notificationHref(item(1, { kind: 'signup', refId: 12 }))).toBe(
      '/admin/accounts?signup=12',
    );
    expect(notificationHref(item(2, { kind: 'pc_change', hospitalName: 'A병원' }))).toBe(
      `/admin/hospitals?q=${encodeURIComponent('A병원')}&pcs=1`,
    );
    expect(notificationHref(item(3, { kind: 'odd_pc', hospitalName: 'A병원' }))).toContain(
      '&pcs=1',
    );
    expect(notificationHref(item(4, { kind: 'key_expiring', hospitalName: 'B병원' }))).toBe(
      `/admin/hospitals?q=${encodeURIComponent('B병원')}`,
    );
    // 따로 볼 화면이 없는 알림
    expect(notificationHref(item(5, { kind: 'collect_fail' }))).toBeNull();
  });

  it('누르면 읽음으로 바꾸고 그 화면으로 간다', async () => {
    const server = fakeServer({
      [LIST]: page(item(7, { kind: 'signup', refId: 12, text: '새 가입 신청' })),
      'POST /admin/notifications/7/read': { status: 204 },
    });
    renderList(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: /새 가입 신청 \(안 읽음\)/ }));
    expect(push).toHaveBeenCalledWith('/admin/accounts?signup=12');
    await waitFor(() => expect(server.callsTo('POST /admin/notifications/7/read')).toHaveLength(1));
  });
});

describe('알림 새로고침', () => {
  it('누르면 다시 받고, 받는 동안 화살표가 돌다가 끝나면 멈춘다', async () => {
    let release: () => void = () => {};
    const server = fakeServer({ [LIST]: page(item(1, { kind: 'collect_fail' })) });
    renderList(<Notifications />);
    await screen.findByText('알림 1');
    const button = screen.getByRole('button', { name: '알림 새로고침' });
    expect(button.querySelector('[data-spinning]')).toBeNull();

    // 다음 응답을 붙잡아 두고 누른다 → 도는 중
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          release = () => resolve(original(...(args as [string, RequestInit])));
        }),
    );
    fireEvent.click(button);
    await waitFor(() => expect(button.querySelector('[data-spinning]')).not.toBeNull());
    release();
    await waitFor(() => expect(button.querySelector('[data-spinning]')).toBeNull());
    expect(server.callsTo(LIST).length).toBeGreaterThanOrEqual(2);
  });
});

describe('첫 화면의 새 알림', () => {
  it('안 읽은 알림만 보여 주고, 없으면 안내', async () => {
    fakeServer({
      [LIST]: page(
        item(1, { kind: 'signup', text: '새 가입 신청' }),
        item(2, { kind: 'collect_fail', text: '병상 수집 실패', read: true }),
      ),
    });
    renderList(<Notifications title="새 알림" unreadOnly />);
    expect(await screen.findByText('새 가입 신청')).toBeTruthy();
    expect(screen.queryByText('병상 수집 실패')).toBeNull();
    expect(screen.getByRole('link', { name: '모든 알림 보기 →' })).toBeTruthy();
  });
});
