import type { ReactNode } from 'react';

// 화면 하나를 통째로 대신하는 안내 (없는 주소·오류·서버 연결 실패·확인 중).
// 빈 화면에 글자 한 줄만 뜨지 않게, 로고가 있는 가운데 카드로 무엇이 문제이고 무엇을 하면 되는지 보여 준다
export function StatusScreen({
  eyebrow,
  title,
  children,
  action,
  tone = 'normal',
  heading = true,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: 'normal' | 'danger';
  // 잠깐 보이는 '확인 중…' 같은 화면은 화면 제목(h1)으로 두지 않는다 (진짜 제목은 곧 뜨는 화면에 있다)
  heading?: boolean;
}) {
  const Title = heading ? 'h1' : 'p';
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-canvas p-8">
      <div className="tile flex w-full max-w-[520px] flex-col items-center gap-5 rounded-2xl p-10 text-center shadow-[var(--shadow-lift)]">
        <div className="flex flex-col gap-2">
          {eyebrow && (
            <span
              aria-hidden
              className={
                tone === 'danger'
                  ? 'text-xs font-bold tracking-wider text-brand uppercase'
                  : 'text-xs font-bold tracking-wider text-muted-foreground uppercase'
              }
            >
              {eyebrow}
            </span>
          )}
          <Title className="text-[28px] font-extrabold tracking-[-0.02em]">{title}</Title>
        </div>
        {children && <div className="text-lg text-muted-foreground">{children}</div>}
        {action}
      </div>
    </div>
  );
}
