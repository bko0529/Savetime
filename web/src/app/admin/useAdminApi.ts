'use client';

import { useCallback } from 'react';
import { apiFetch } from '@/lib/api/client';
import { bearer, useAdminAuth, withAdminToken } from './AdminAuth';

// 관리자 API 호출: Authorization 헤더를 붙인다. 15분 토큰이 끝났으면 새 토큰을 받아 한 번 더 부르고,
// 다시 로그인해야 하면 로그아웃시켜 로그인 화면으로 보낸다 (SFR-082)
export function useAdminApi() {
  const auth = useAdminAuth();
  const { current, refresh, signOut } = auth;
  return useCallback(
    <T>(path: string, init: RequestInit = {}): Promise<T> =>
      withAdminToken({ current, refresh, signOut }, (tokens) =>
        apiFetch<T>(path, { ...init, headers: { ...bearer(tokens), ...init.headers } }),
      ),
    [current, refresh, signOut],
  );
}
