import { cn } from '@/lib/utils';

// 세이브타임 로고 가이드 색 (119 남색·119 빨강). 빨강은 십자 세로획 하나에만 쓴다
export const LOGO_NAVY = '#14284B';
export const LOGO_RED = '#E60012';

// 세이브타임 심볼 (로고 가이드의 '원라인 스톱워치').
// 시계판을 그리던 선 하나가 왼쪽에서 그대로 십자의 가로획이 되고, 빨간 세로획이 십자를 완성한다.
// 그림 파일 대신 SVG 로 그려서 어느 크기에서도 선이 또렷하고 비율이 그대로다.
// 32px 이하에서는 가이드대로 선을 굵게(symbol-small). 꾸밈용이라 화면 읽기 프로그램에는 숨긴다
export function BrandLogo({ className, small }: { className?: string; small?: boolean }) {
  const w = small ? 12 : 10;
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-11 shrink-0', className)}
    >
      {/* 위쪽 꼭지(버튼)와 몸통을 잇는 짧은 줄기 */}
      <path d="M41 12H59M50 12V28" stroke={LOGO_NAVY} strokeWidth={w} />
      {/* 시계판: 12시에서 시계 방향으로 9시까지 → 그대로 가로획 */}
      <path d="M50 28A32 32 0 1 1 18 60H65" stroke={LOGO_NAVY} strokeWidth={w} />
      {/* 빨간 세로획 */}
      <path d="M50 41V80" stroke={LOGO_RED} strokeWidth={w} />
    </svg>
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
        <BrandLogo className="size-10" />
        세이브타임 관리자
      </p>
    </header>
  );
}
