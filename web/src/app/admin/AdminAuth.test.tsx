import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider, useAdminAuth } from './AdminAuth';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

const TOKENS = { accessToken: 'a.b.c', refreshToken: 'r' };

function Probe() {
  const { tokens, ready, signIn, signOut } = useAdminAuth();
  return (
    <>
      <p>{ready ? (tokens ? '로그인' : '로그아웃') : '읽는 중'}</p>
      <button onClick={() => signIn(TOKENS)}>in</button>
      <button onClick={signOut}>out</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('관리자 로그인 보관', () => {
  it('기본(운영): 메모리에만 두고 sessionStorage 에 남기지 않는다', () => {
    render(
      <AdminAuthProvider keepLogin={false}>
        <Probe />
      </AdminAuthProvider>,
    );
    act(() => screen.getByText('in').click());
    expect(screen.getByText('로그인')).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
  });

  it('시연용 로그인 유지: 새로고침(다시 그림)해도 로그인, 로그아웃하면 지운다', () => {
    const first = render(
      <AdminAuthProvider keepLogin>
        <Probe />
      </AdminAuthProvider>,
    );
    act(() => screen.getByText('in').click());
    first.unmount();

    render(
      <AdminAuthProvider keepLogin>
        <Probe />
      </AdminAuthProvider>,
    );
    expect(screen.getByText('로그인')).toBeTruthy();
    act(() => screen.getByText('out').click());
    expect(sessionStorage.length).toBe(0);
  });
});
