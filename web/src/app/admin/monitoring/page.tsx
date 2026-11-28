import { AdminShell } from '../AdminShell';
import { AuditLog } from './AuditLog';
import { HospitalStats } from './HospitalStats';
import { Notifications } from './Notifications';

// A-02 모니터링: 관리자 알림(SFR-100) · 병원 응답 통계(SFR-106) · 작업 이력(SFR-091).
// 기능 켜고 끄기(QUR-013) 칸은 시연 화면에서 뺐다 (FeatureFlags.tsx 는 남겨 둠)
export default function MonitoringPage() {
  return (
    <AdminShell>
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">모니터링</h1>
      <Notifications />
      <HospitalStats />
      <AuditLog />
    </AdminShell>
  );
}
