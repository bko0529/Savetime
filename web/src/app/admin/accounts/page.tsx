import { AdminShell } from '../AdminShell';
import { ParamedicAdmin } from './ParamedicAdmin';

// A-01 계정: 대원 계정 정지·해제(SFR-151). 가입 승인·반려(SFR-083)는 대원 가입 신청(SFR-017)이 생기면 붙인다
export default function AccountsPage() {
  return (
    <AdminShell>
      <ParamedicAdmin />
      <p className="text-lg text-muted-foreground">
        구급대원 가입 승인·반려(SFR-083)는 준비 중이에요.
      </p>
    </AdminShell>
  );
}
