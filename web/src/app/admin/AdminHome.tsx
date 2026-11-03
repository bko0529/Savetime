'use client';

import { Button } from '@/components/ui/button';
import { RequireAdmin, useAdminAuth } from './AdminAuth';

export function AdminHome() {
  const { signOut } = useAdminAuth();
  return (
    <RequireAdmin>
      <main className="flex flex-1 flex-col gap-4 p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">관리자</h1>
          <Button variant="outline" onClick={signOut}>
            로그아웃
          </Button>
        </div>
        <p className="text-xl">가입 승인·병원 관리 메뉴는 다음 단계에서 추가돼요.</p>
      </main>
    </RequireAdmin>
  );
}
