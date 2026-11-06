'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RequireAdmin, useAdminAuth } from './AdminAuth';
import { UnreadBadge } from './monitoring/Notifications';

// 관리자 메뉴 3개 (SFR-082 인수 기준: 계정 A-01 · 모니터링 A-02 · 병원 관리 A-03)
export const ADMIN_MENUS = [
  {
    href: '/admin/accounts',
    label: '계정',
    screen: 'A-01',
    about: '구급대원 가입 승인·반려, 계정 정지·해제',
  },
  {
    href: '/admin/monitoring',
    label: '모니터링',
    screen: 'A-02',
    about: '알림, 관리자 작업 이력, 통계',
  },
  {
    href: '/admin/hospitals',
    label: '병원 관리',
    screen: 'A-03',
    about: '병원 계정·라이선스 키 발급, 등록 PC',
  },
] as const;

// 관리자 화면 공통 틀: 로그인 확인 + 위쪽 메뉴.
// 메뉴는 Link(화면 안 이동)라서 메모리에 둔 관리자 토큰이 그대로 남는다. 주소창에 직접 치면 새로 열리므로 다시 로그인한다
export function AdminShell({ children }: { children: ReactNode }) {
  const { signOut } = useAdminAuth();
  const pathname = usePathname();

  return (
    <RequireAdmin>
      <div className="flex flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-foreground px-8 py-4">
          <Link href="/admin" className="text-2xl font-bold">
            세이브타임 관리자
          </Link>
          <nav aria-label="관리자 메뉴" className="flex gap-2">
            {ADMIN_MENUS.map((m) => {
              const current = pathname.startsWith(m.href);
              return (
                <Link
                  key={m.href}
                  href={m.href}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'rounded-lg px-4 py-2 text-lg font-semibold hover:bg-muted',
                    current && 'bg-foreground text-background hover:bg-foreground',
                  )}
                >
                  {m.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-3">
            <UnreadBadge />
            <Button variant="outline" onClick={signOut}>
              로그아웃
            </Button>
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-4 p-8">{children}</main>
      </div>
    </RequireAdmin>
  );
}

// 아직 내용을 만들지 않은 메뉴. 어느 요구사항·스프린트에서 채우는지 보여 준다
export function ComingSoon({
  title,
  items,
}: {
  title: string;
  items: { label: string; when: string }[];
}) {
  return (
    <AdminShell>
      <h1 className="text-3xl font-bold">{title}</h1>
      <p className="text-xl">아직 준비 중이에요. 아래 기능이 차례로 들어와요.</p>
      <ul className="flex flex-col gap-2 text-lg">
        {items.map((i) => (
          <li key={i.label}>
            · {i.label} <span className="text-muted-foreground">({i.when})</span>
          </li>
        ))}
      </ul>
    </AdminShell>
  );
}
