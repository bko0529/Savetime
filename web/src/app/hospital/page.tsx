import { HospitalHome } from './HospitalHome';

export default function HospitalPage() {
  return (
    <main className="flex flex-1 flex-col">
      {/* 제목은 근무 전·근무 중에 따라 바뀌어서 HospitalHome 이 그린다 */}
      <HospitalHome />
    </main>
  );
}
