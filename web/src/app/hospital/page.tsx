import { HospitalHome } from './HospitalHome';

export default function HospitalPage() {
  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-3xl font-bold">근무 시작</h1>
      <HospitalHome />
    </main>
  );
}
