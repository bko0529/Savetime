/**
 * 승인된 대원의 첫 화면 (임시). 근무 시작·팀 화면은 3단계에서 이 자리에 붙인다.
 */
import { useAuth } from '../src/auth/AuthProvider';
import { PhoneScreen, Tile, Txt } from '../src/ui/kit';
import { color, text } from '../src/ui/theme';

export default function HomeScreen() {
  const { state } = useAuth();
  if (state.status !== 'signedIn') return null;
  const { name, rank } = state.me;
  return (
    <PhoneScreen title={`${name ?? ''} ${rank ?? ''}님`.trim()}>
      <Tile style={{ padding: 20 }}>
        <Txt style={[text.body, { color: color.muted }]}>근무 시작 화면은 준비 중이에요.</Txt>
      </Tile>
    </PhoneScreen>
  );
}
