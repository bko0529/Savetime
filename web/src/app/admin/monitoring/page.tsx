import { ComingSoon } from '../AdminShell';

// A-02 모니터링
export default function MonitoringPage() {
  return (
    <ComingSoon
      title="모니터링"
      items={[
        { label: '관리자 작업 이력', when: 'SFR-091, S2' },
        { label: '관리자 알림 (수집 실패·PC 등록 등)', when: 'SFR-100, S5' },
        { label: '병원 응답 통계', when: 'SFR-106, S7' },
      ]}
    />
  );
}
