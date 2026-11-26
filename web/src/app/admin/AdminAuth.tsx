'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { components } from '@/lib/api/schema';

export type Tokens = components['schemas']['Tokens'];

type AdminAuth = {
  tokens: Tokens | null;
  // 보관된 로그인을 다 읽었는지. 시연용 '로그인 유지'일 때 읽기 전에 로그인 화면으로 보내지 않게 한다
  ready: boolean;
  signIn: (tokens: Tokens) => void;
  signOut: () => void;
};

const AdminAuthContext = createContext<AdminAuth | null>(null);

// 시연용: NEXT_PUBLIC_ADMIN_KEEP_LOGIN=1 이면 새로고침해도 로그인이 유지된다 (그 탭의 sessionStorage, 탭을 닫으면 사라짐).
// 운영에서는 켜지 않는다. 토큰이 끝나면(서버 ADMIN_ACCESS_MINUTES, 기본 15분) 평소처럼 다시 로그인한다
export const KEEP_LOGIN = process.env.NEXT_PUBLIC_ADMIN_KEEP_LOGIN === '1';
const STORE_KEY = 'savetime.admin.tokens';

// 관리자 토큰은 기본적으로 React 상태(메모리)에만 둔다. localStorage·sessionStorage 에 두면 화면에 악성 스크립트가
// 들어왔을 때 가장 센 권한의 토큰을 읽어 갈 수 있다. 대신 새로고침하면 다시 로그인(비밀번호 + OTP)해야 한다.
export function AdminAuthProvider({
  children,
  keepLogin = KEEP_LOGIN,
}: {
  children: ReactNode;
  keepLogin?: boolean;
}) {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [ready, setReady] = useState(!keepLogin);

  // 화면이 뜬 뒤에 읽는다 (서버에서 그릴 때는 sessionStorage 가 없다)
  useEffect(() => {
    if (!keepLogin) return;
    try {
      const saved = sessionStorage.getItem(STORE_KEY);
      if (saved) setTokens(JSON.parse(saved) as Tokens);
    } catch {
      sessionStorage.removeItem(STORE_KEY);
    }
    setReady(true);
  }, [keepLogin]);

  // 함수가 그릴 때마다 새로 만들어지면 이걸 의존하는 effect 가 끝없이 다시 돈다 → useCallback 으로 고정
  const signIn = useCallback(
    (next: Tokens) => {
      if (keepLogin) sessionStorage.setItem(STORE_KEY, JSON.stringify(next));
      setTokens(next);
    },
    [keepLogin],
  );
  const signOut = useCallback(() => {
    if (keepLogin) sessionStorage.removeItem(STORE_KEY);
    setTokens(null);
  }, [keepLogin]);

  return (
    <AdminAuthContext.Provider value={{ tokens, ready, signIn, signOut }}>
      {children}
    </AdminAuthContext.Provider>
  );
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
  const { tokens, ready } = useAdminAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !tokens) router.replace('/admin/login');
  }, [ready, tokens, router]);

  return tokens ? children : null;
}
