import Image from 'next/image';
import { cn } from '@/lib/utils';

// 세이브타임 로고 (대원 앱 Lovable 시안과 같은 그림, web/public/savetime-logo.png).
// 꾸밈용이라 화면 읽기 프로그램에는 숨긴다. 옆에 '세이브타임'·화면 제목 글자가 따로 있다
export function BrandLogo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-11 shrink-0 place-items-center overflow-hidden rounded-2xl bg-card shadow-[var(--shadow-card)]',
        className,
      )}
    >
      <Image
        src="/savetime-logo.png"
        alt=""
        width={160}
        height={142}
        // 화면 맨 위에 있어서 늦게 불러오면 빈 동그라미가 잠깐 보인다
        loading="eager"
        className="size-full object-contain"
      />
    </span>
  );
}

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

// 관리자 로그인처럼 메뉴가 없는 화면의 위쪽 띠: 로고 + '세이브타임 관리자'
export function AdminTopBar() {
  return (
    <header className="surface-header relative overflow-hidden border-b border-border/70 px-8 py-4">
      <span
        aria-hidden
        className="pointer-events-none absolute -top-20 -right-12 size-52 rounded-full bg-brand/10 blur-3xl"
      />
      <EcgLine className="right-6 bottom-0 w-44 text-brand/30" />
      <p className="relative mx-auto flex w-full max-w-[1440px] items-center gap-3 text-xl font-extrabold tracking-tight">
        <BrandLogo className="size-10 rounded-xl" />
        세이브타임 관리자
      </p>
    </header>
  );
}
