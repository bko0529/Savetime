import { AdminTopBar } from '@/components/brand/Brand';
import { KEEP_LOGIN } from '../AdminAuth';
import { LoginForm } from './LoginForm';

// 관리자 로그인 (대원 앱 Lovable 시안과 같은 모양: 위쪽 띠 + 가운데 카드)
export default function AdminLoginPage() {
  return (
    <>
      <AdminTopBar />
      <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
        <div className="tile flex w-full max-w-[540px] flex-col gap-6 rounded-2xl p-8 shadow-[var(--shadow-lift)]">
          <div className="flex flex-col gap-1.5">
            <span aria-hidden className="text-xs font-bold tracking-wider text-brand uppercase">
              SaveTime Admin
            </span>
            <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">관리자 로그인</h1>
          </div>
          {/* 관리자 토큰은 보안 때문에 화면 메모리에만 둔다(AdminAuth.tsx). 새로고침하면 로그인이 풀리는 게
              고장이 아니라는 걸 로그인 화면에서 미리 알려 준다 */}
          {/* 시연용 로그인 유지(NEXT_PUBLIC_ADMIN_KEEP_LOGIN=1)를 켠 경우엔 이 안내가 맞지 않아 뺀다 */}
          {!KEEP_LOGIN && (
            <p className="well rounded-xl px-4 py-3 text-[15px] leading-relaxed text-muted-foreground">
              <span className="font-bold text-foreground">새로고침하면 다시 로그인해야 해요.</span>{' '}
              보안을 위해 로그인은 이 화면을 열어 둔 동안만 유지돼요. 로그인한 뒤에는 위쪽 메뉴로
              이동해 주세요.
            </p>
          )}
          <LoginForm />
        </div>
      </main>
    </>
  );
}
