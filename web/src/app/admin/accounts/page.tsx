import { AdminShell } from '../AdminShell';
import { ParamedicAdmin } from './ParamedicAdmin';
import { SignupReview } from './SignupReview';

// A-01 계정: 가입 승인·반려(SFR-083) · 대원 계정 정지·해제(SFR-151)
export default function AccountsPage() {
  return (
    <AdminShell>
      <SignupReview />
      <ParamedicAdmin />
    </AdminShell>
  );
}
