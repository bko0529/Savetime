import { AdminShell } from '../AdminShell';
import { HospitalAdmin } from './HospitalAdmin';

// A-03 병원 관리 (SFR-123)
export default function HospitalsPage() {
  return (
    <AdminShell>
      <HospitalAdmin />
    </AdminShell>
  );
}
