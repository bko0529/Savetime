import { act, cleanup, render } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from './AdminAuth';
import { useAdminApi } from './useAdminApi';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

type Handle = { api: ReturnType<typeof useAdminApi>; auth: ReturnType<typeof useAdminAuth> };

// 로그인한 상태에서 관리자 API 를 부를 수 있는 손잡이를 꺼낸다
function Grab({ into }: { into: (h: Handle) => void }) {
  const api = useAdminApi();
  const auth = useAdminAuth();
  const { signIn } = auth;
  useEffect(() => {
    signIn({ accessToken: 'old-access', refreshToken: 'old-refresh' });
  }, [signIn]);
  into({ api, auth });
  return null;
}

function setup(): Handle {
  let handle!: Handle;
  const wrap = (ui: ReactNode) => <AdminAuthProvider>{ui}</AdminAuthProvider>;
  render(wrap(<Grab into={(h) => (handle = h)} />));
  return new Proxy({} as Handle, { get: (_, k: keyof Handle) => handle[k] });
}

const authHeader = (fetchMock: ReturnType<typeof vi.fn>, i: number) =>
  (fetchMock.mock.calls[i][1] as RequestInit).headers as Record<string, string>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('관리자 토큰 15분 만료 뒤 자동 갱신 (SFR-082, SER-016)', () => {
  it('토큰이 끝났으면 새 토큰을 받아 같은 요청을 한 번 더 보낸다', async () => {
    const server = fakeServer({
      'GET /admin/signups': [
        { status: 401, body: apiError('TOKEN_EXPIRED') },
        { status: 200, body: { items: [] } },
      ],
      'POST /admin/auth/refresh': {
        status: 200,
        body: { accessToken: 'new-access', refreshToken: 'new-refresh' },
      },
    });
    const h = setup();

    await expect(h.api('/admin/signups')).resolves.toEqual({ items: [] });

    expect(server.callsTo('POST /admin/auth/refresh')[0].body).toEqual({
      refreshToken: 'old-refresh',
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(authHeader(fetchMock, 0).Authorization).toBe('Bearer old-access');
    expect(authHeader(fetchMock, 2).Authorization).toBe('Bearer new-access');
    expect(h.auth.current()).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  });

  it('여러 요청이 동시에 만료돼도 재발급은 한 번만 한다', async () => {
    const server = fakeServer({
      'GET /admin/signups': [
        { status: 401, body: apiError('TOKEN_EXPIRED') },
        { status: 401, body: apiError('TOKEN_EXPIRED') },
        { status: 200, body: { items: [] } },
      ],
      'POST /admin/auth/refresh': {
        status: 200,
        body: { accessToken: 'new-access', refreshToken: 'new-refresh' },
      },
    });
    const h = setup();

    await Promise.all([h.api('/admin/signups'), h.api('/admin/signups')]);

    expect(server.callsTo('POST /admin/auth/refresh')).toHaveLength(1);
  });

  it('갱신 토큰도 끝났으면(14시간) 로그아웃한다', async () => {
    fakeServer({
      'GET /admin/signups': { status: 401, body: apiError('TOKEN_EXPIRED') },
      'POST /admin/auth/refresh': { status: 401, body: apiError('TOKEN_EXPIRED') },
    });
    const h = setup();

    await act(async () => {
      await expect(h.api('/admin/signups')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    });
    expect(h.auth.tokens).toBeNull();
  });

  it('TOKEN_REVOKED 는 갱신하지 않고 바로 로그아웃한다', async () => {
    const server = fakeServer({
      'GET /admin/signups': { status: 401, body: apiError('TOKEN_REVOKED') },
      'POST /admin/auth/refresh': { status: 200, body: {} },
    });
    const h = setup();

    await act(async () => {
      await expect(h.api('/admin/signups')).rejects.toMatchObject({ code: 'TOKEN_REVOKED' });
    });
    expect(server.callsTo('POST /admin/auth/refresh')).toHaveLength(0);
    expect(h.auth.tokens).toBeNull();
  });
});
