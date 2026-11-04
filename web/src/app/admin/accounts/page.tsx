import { ComingSoon } from '../AdminShell';

// A-01 계정
export default function AccountsPage() {
  return (
    <ComingSoon
      title="계정"
      items={[
        { label: '구급대원 가입 승인·반려', when: 'SFR-083, S5' },
        { label: '계정 정지·해제·비밀번호 초기화', when: 'SFR-151, S5' },
      ]}
    />
  );
}
