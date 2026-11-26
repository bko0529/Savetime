'use client';

import Link from 'next/link';
import { ADMIN_MENUS, AdminShell } from './AdminShell';

// 관리자 첫 화면: 메뉴 3개 (SFR-082). 대원 앱 시안과 같은 카드 모양
export function AdminHome() {
  return (
    <AdminShell>
      <div className="flex flex-col gap-1">
        <span aria-hidden className="text-xs font-bold tracking-wider text-brand uppercase">
          SaveTime Console
        </span>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">관리자</h1>
      </div>
      <ul className="grid gap-5 sm:grid-cols-3">
        {ADMIN_MENUS.map((m) => (
          <li key={m.href}>
            <Link
              href={m.href}
              className="tile flex h-full flex-col gap-3 rounded-2xl p-6 transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[var(--shadow-lift)]"
            >
              {/* 화면 번호(A-01 등): 설계 문서와 맞춰 보기 쉽게 */}
              <span
                aria-hidden
                className="w-fit rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-bold text-muted-foreground"
              >
                {m.screen}
              </span>
              <span className="section-title text-2xl tracking-[-0.02em]">{m.label}</span>
              <span className="text-base leading-relaxed text-muted-foreground">{m.about}</span>
            </Link>
          </li>
        ))}
      </ul>
    </AdminShell>
  );
}
