import { cn } from '@/lib/utils';

// 위쪽 띠 오른쪽의 심전도 모양 선 (꾸밈용)
export function EcgLine({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 220 40"
      fill="none"
      className={cn('pointer-events-none absolute text-brand/40', className)}
    >
      <path
        d="M0 22 H52 L62 22 68 10 74 32 80 4 87 36 93 22 H128 L136 22 141 15 146 27 151 22 H220"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 관리자 로그인처럼 메뉴가 없는 화면의 위쪽 띠: '세이브타임 관리자'
export function AdminTopBar() {
  return (
    <header className="surface-header relative overflow-hidden border-b border-border/70 px-8 py-4">
      <span
        aria-hidden
        className="pointer-events-none absolute -top-20 -right-12 size-52 rounded-full bg-brand/10 blur-3xl"
      />
      <EcgLine className="right-6 bottom-0 w-44 text-brand/30" />
      <p className="relative mx-auto flex w-full max-w-[1440px] items-center gap-3 text-xl font-extrabold tracking-tight">
        세이브타임 관리자
      </p>
    </header>
  );
}
