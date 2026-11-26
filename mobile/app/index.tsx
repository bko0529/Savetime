/**
 * 로그인 다음 첫 화면 (임시). me.status 로 무엇을 보여 줄지 고른다 (SFR-022·083).
 * 승인 대기 화면은 2단계, 근무 시작·팀 화면은 3단계에서 이 자리에 붙인다.
 */
import { useAuth } from '../src/auth/AuthProvider';
import { statusMessage } from '../src/auth/statusMessage';
import { PhoneScreen, Tile, Txt } from '../src/ui/kit';
import { color, text } from '../src/ui/theme';

export default function HomeScreen() {
  const { state } = useAuth();
  if (state.status !== 'signedIn') return null;
  const msg = statusMessage(state.me);
  return (
    <PhoneScreen title={msg.title}>
      <Tile style={{ padding: 20 }}>
        <Txt style={[text.body, { color: color.muted }]}>{msg.body}</Txt>
      </Tile>
    </PhoneScreen>
  );
}
