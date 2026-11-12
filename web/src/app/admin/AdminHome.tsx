'use client';

import Link from 'next/link';
import { ADMIN_MENUS, AdminShell } from './AdminShell';

// 관리자 첫 화면: 메뉴 3개 (SFR-082)
export function AdminHome() {
  return (
    <AdminShell>
      <h1 className="section-title text-3xl">관리자</h1>
      <ul className="grid gap-4 sm:grid-cols-3">
        {ADMIN_MENUS.map((m) => (
          <li key={m.href}>
            <Link
              href={m.href}
              className="flex h-full flex-col gap-2 tile p-6 transition-shadow hover:shadow-[var(--shadow-lift)]"
            >
              <span className="text-2xl font-bold">{m.label}</span>
              <span className="text-lg text-muted-foreground">{m.about}</span>
            </Link>
          </li>
        ))}
      </ul>
    </AdminShell>
  );
}
