import { LoginForm } from './LoginForm';

export default function AdminLoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <div className="tile flex w-full max-w-xl flex-col gap-6 p-10">
        <h1 className="section-title text-4xl">관리자 로그인</h1>
        <LoginForm />
      </div>
    </main>
  );
}
