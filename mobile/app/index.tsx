/**
 * 근무 중 첫 화면 (임시). 이송 요청 홈은 5·6단계에서 이 자리에 붙인다.
 * 근무 종료(진행 중 이송 확인 포함)는 8단계 설정 화면에서. 지금은 확인용 로그아웃만.
 */
import { LogOut } from 'lucide-react-native';
import { useAuth } from '../src/auth/AuthProvider';
import { fromServerRole, teamStore } from '../src/duty/team';
import { useStore } from '../src/state/store';
import { BigButton, KeyVal, PhoneScreen, Tile } from '../src/ui/kit';
import { color } from '../src/ui/theme';

export default function HomeScreen() {
  const { state, logout } = useAuth();
  const { team } = useStore(teamStore);
  if (state.status !== 'signedIn') return null;
  const { name, rank } = state.me;
  const t = team === 'loading' ? null : team;
  const me = t?.members?.find((m) => m.isMe);
  return (
    <PhoneScreen
      title={`${name ?? ''} ${rank ?? ''}님`.trim()}
      subtitle="근무 중 · 이송 요청 화면은 준비 중이에요"
      footer={
        <BigButton
          variant="outline"
          onPress={() => void logout()}
          icon={<LogOut size={18} color={color.foreground} />}
        >
          로그아웃
        </BigButton>
      }
    >
      <Tile divided>
        <KeyVal label="팀 코드" value={t?.code ?? '-'} />
        <KeyVal label="팀원" value={`${t?.members?.length ?? 1}명`} />
        <KeyVal label="내 역할" value={fromServerRole(me?.role)} />
      </Tile>
    </PhoneScreen>
  );
}
