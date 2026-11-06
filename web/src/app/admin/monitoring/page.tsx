import { AdminShell } from '../AdminShell';
import { AuditLog } from './AuditLog';
import { Notifications } from './Notifications';

// A-02 모니터링: 관리자 알림(SFR-100) · 작업 이력(SFR-091). 통계(SFR-106, S7)는 뒤에 붙는다
export default function MonitoringPage() {
  return (
    <AdminShell>
      <h1 className="text-3xl font-bold">모니터링</h1>
      <Notifications />
      <AuditLog />
      <p className="text-lg text-muted-foreground">병원 응답 통계(SFR-106, S7)는 준비 중이에요.</p>
    </AdminShell>
  );
}
