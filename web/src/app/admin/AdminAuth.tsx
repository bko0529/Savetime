'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { components } from '@/lib/api/schema';

export type Tokens = components['schemas']['Tokens'];

type AdminAuth = {
  tokens: Tokens | null;
  signIn: (tokens: Tokens) => void;
  signOut: () => void;
};

const AdminAuthContext = createContext<AdminAuth | null>(null);

// 관리자 토큰은 React 상태(메모리)에만 둔다. localStorage·sessionStorage 에 두면 화면에 악성 스크립트가
// 들어왔을 때 가장 센 권한의 토큰을 읽어 갈 수 있다. 대신 새로고침하면 다시 로그인(비밀번호 + OTP)해야 한다.
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  return (
    <AdminAuthContext.Provider
      value={{ tokens, signIn: setTokens, signOut: () => setTokens(null) }}
    >
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
  const { tokens } = useAdminAuth();
  const router = useRouter();

  useEffect(() => {
    if (!tokens) router.replace('/admin/login');
  }, [tokens, router]);

  return tokens ? children : null;
}
