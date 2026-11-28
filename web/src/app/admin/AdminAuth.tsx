'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, apiFetch } from '@/lib/api/client';
import type { components } from '@/lib/api/schema';

export type Tokens = components['schemas']['Tokens'];

type AdminAuth = {
  tokens: Tokens | null;
  signIn: (tokens: Tokens) => void;
  signOut: () => void;
  // 지금 쓰는 토큰 (화면이 다시 그려지기 전에도 갱신된 값을 바로 읽으려고)
  current: () => Tokens | null;
  // 15분 토큰이 끝났을 때 갱신 토큰으로 새 토큰을 받는다. 못 받으면 로그아웃하고 null
  refresh: (expiredAccessToken: string | undefined) => Promise<Tokens | null>;
};

const AdminAuthContext = createContext<AdminAuth | null>(null);

// 관리자 토큰은 React 상태(메모리)에만 둔다. localStorage·sessionStorage 에 두면 화면에 악성 스크립트가
// 들어왔을 때 가장 센 권한의 토큰을 읽어 갈 수 있다. 대신 새로고침하면 다시 로그인(비밀번호 + OTP)해야 한다.
// 갱신 토큰도 같은 이유로 메모리에만 둔다. 15분마다 새 토큰을 받아 화면은 끊기지 않고,
// 처음 로그인부터 14시간이 지나면 서버가 거절해서 다시 로그인한다 (SFR-082, SER-016).
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const latest = useRef<Tokens | null>(null);
  const refreshing = useRef<Promise<Tokens | null> | null>(null);

  const signIn = useCallback((next: Tokens) => {
    latest.current = next;
    setTokens(next);
  }, []);
  const signOut = useCallback(() => {
    latest.current = null;
    setTokens(null);
  }, []);
  const current = useCallback(() => latest.current, []);

  const refresh = useCallback(
    (expiredAccessToken: string | undefined) => {
      // 다른 요청이 먼저 새 토큰을 받아 왔으면 그걸 쓴다 (갱신 토큰은 한 번만 쓸 수 있다)
      const now = latest.current;
      if (now && now.accessToken !== expiredAccessToken) return Promise.resolve(now);
      // 여러 요청이 동시에 만료돼도 재발급은 한 번만 한다
      refreshing.current ??= (async () => {
        try {
          if (!now?.refreshToken) throw new ApiError(401, 'TOKEN_REVOKED', '다시 로그인해 주세요');
          const next = await apiFetch<Tokens>('/admin/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken: now.refreshToken }),
          });
          signIn(next);
          return next;
        } catch (error) {
          // 갱신 토큰도 끝났거나(14시간) 못 쓰게 됐으면 로그인 화면으로
          if (error instanceof ApiError && error.status === 401) signOut();
          return null;
        } finally {
          refreshing.current = null;
        }
      })();
      return refreshing.current;
    },
    [signIn, signOut],
  );

  const value = useMemo(
    () => ({ tokens, signIn, signOut, current, refresh }),
    [tokens, signIn, signOut, current, refresh],
  );
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

// 관리자 토큰을 붙여 부르고, 15분 토큰이 끝났으면 새 토큰을 받아 한 번만 다시 부른다.
// 다시 로그인해야 하는 경우(TOKEN_REVOKED·갱신 실패)는 로그아웃시킨다
export async function withAdminToken<T>(
  auth: Pick<AdminAuth, 'current' | 'refresh' | 'signOut'>,
  call: (tokens: Tokens | null) => Promise<T>,
): Promise<T> {
  const used = auth.current();
  try {
    return await call(used);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === 'TOKEN_EXPIRED') {
      const next = await auth.refresh(used?.accessToken);
      if (next) return call(next);
    }
    if (error.code === 'TOKEN_REVOKED') auth.signOut();
    throw error;
  }
}

export function useAdminAuth(): AdminAuth {
  const auth = useContext(AdminAuthContext);
  if (!auth) throw new Error('AdminAuthProvider 안에서만 쓸 수 있어요');
  return auth;
}

// 관리자 API 를 부를 때 붙이는 헤더 (Authorization: Bearer <accessToken>)
export function bearer(tokens: Tokens | null): Record<string, string> {
  return tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {};
}

// 로그인 안 한 상태로 관리자 화면에 들어오면 로그인 화면으로 보낸다 (SFR-082).
// 화면을 가리는 것뿐이고, 실제 권한 확인은 서버가 요청마다 토큰으로 한다.
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { tokens } = useAdminAuth();
  const router = useRouter();

  useEffect(() => {
    if (!tokens) router.replace('/admin/login');
  }, [tokens, router]);

  return tokens ? children : null;
}
