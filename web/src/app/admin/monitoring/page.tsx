import { AdminShell } from '../AdminShell';
import { AuditLog } from './AuditLog';
import { HospitalStats } from './HospitalStats';
import { Notifications } from './Notifications';

// A-02 모니터링: 관리자 알림(SFR-100) · 병원 응답 통계(SFR-106) · 작업 이력(SFR-091)
export default function MonitoringPage() {
  return (
    <AdminShell>
      <h1 className="text-3xl font-bold">모니터링</h1>
      <Notifications />
      <HospitalStats />
      <AuditLog />
    </AdminShell>
  );
}
