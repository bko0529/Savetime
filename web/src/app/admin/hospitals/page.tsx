import { ComingSoon } from '../AdminShell';

// A-03 병원 관리
export default function HospitalsPage() {
  return (
    <ComingSoon
      title="병원 관리"
      items={[
        { label: '병원 계정·라이선스 키 발급, 병원 정지', when: 'SFR-123, S2' },
        { label: '라이선스 키 폐기·재발급, 등록 PC 해제', when: 'SFR-146·147, S5' },
      ]}
    />
  );
}
