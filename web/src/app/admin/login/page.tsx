import { LoginForm } from './LoginForm';

export default function AdminLoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <h1 className="text-4xl font-bold">관리자 로그인</h1>
      <LoginForm />
    </main>
  );
}
