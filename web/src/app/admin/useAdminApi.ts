'use client';

import { useCallback } from 'react';
import { ApiError, apiFetch } from '@/lib/api/client';
import { bearer, useAdminAuth } from './AdminAuth';

// 관리자 토큰이 끝났거나(15분) 쓸 수 없게 되면 서버가 이 코드로 답한다
const SIGNED_OUT_CODES = new Set(['TOKEN_EXPIRED', 'TOKEN_REVOKED']);

// 관리자 API 호출: Authorization 헤더를 붙이고, 토큰이 끝났으면 로그아웃시켜 로그인 화면으로 보낸다.
// (토큰 자동 재발급은 관리자 refresh API 가 생기면 붙인다)
export function useAdminApi() {
  const { tokens, signOut } = useAdminAuth();
  return useCallback(
    async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      try {
        return await apiFetch<T>(path, {
          ...init,
          headers: { ...bearer(tokens), ...init.headers },
        });
      } catch (error) {
        if (error instanceof ApiError && SIGNED_OUT_CODES.has(error.code)) signOut();
        throw error;
      }
    },
    [tokens, signOut],
  );
}
