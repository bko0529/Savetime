import { Logo } from '@/components/hospital/Logo';
import { RegisterForm } from './RegisterForm';

export default function RegisterPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-canvas p-8">
      <p className="flex items-center gap-3 text-[20px] font-extrabold">
        <Logo />
        세이브타임 병원 웹
      </p>
      <div className="tile flex w-full max-w-[560px] flex-col gap-6 rounded-2xl p-[32px] shadow-[var(--shadow-lift)]">
        <h1 className="text-[30px] font-extrabold tracking-[-0.02em]">병원 PC 등록</h1>
        <RegisterForm />
      </div>
    </main>
  );
}
