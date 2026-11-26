import { AdminTopBar } from '@/components/brand/Brand';
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
          <LoginForm />
        </div>
      </main>
    </>
  );
}
