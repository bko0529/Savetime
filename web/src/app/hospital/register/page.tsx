import { RegisterForm } from './RegisterForm';

export default function RegisterPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <h1 className="text-4xl font-bold">병원 PC 등록</h1>
      <RegisterForm />
    </main>
  );
}
