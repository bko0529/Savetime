import { RegisterForm } from './RegisterForm';

export default function RegisterPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <div className="tile flex w-full max-w-2xl flex-col gap-6 p-10">
        <h1 className="section-title text-4xl">병원 PC 등록</h1>
        <RegisterForm />
      </div>
    </main>
  );
}
