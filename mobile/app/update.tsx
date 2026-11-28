/**
 * 업데이트 필요 (SFR-142). 서버가 정한 최소 버전보다 낮으면 기능을 막고 이 안내만 보여 준다.
 * 스토어 주소는 앱을 스토어에 올린 뒤 넣는다 (지금은 안내 문구만).
 */
import { Download, Smartphone } from 'lucide-react-native';
import { BigButton, CenterMessage, KeyVal, Tile } from '../src/ui/kit';
import { PhoneScreen } from '../src/ui/kit';
import { APP_VERSION, configStore } from '../src/state/config';
import { useStore } from '../src/state/store';
import { color } from '../src/ui/theme';

export default function UpdateScreen() {
  const { minAppVersion } = useStore(configStore);
  return (
    <PhoneScreen
      title="업데이트가 필요해요"
      subtitle="지금 버전으로는 쓸 수 없어요"
      footer={
        <BigButton size="lg" disabled icon={<Download size={20} color={color.muted} />}>
          스토어에서 업데이트
        </BigButton>
      }
    >
      <CenterMessage
        icon={<Smartphone size={28} color={color.warning} />}
        title="새 버전이 나왔어요"
        body="업데이트하면 이어서 쓸 수 있어요"
      />
      <Tile divided>
        <KeyVal label="설치된 버전" value={APP_VERSION} />
        <KeyVal
          label="최소 지원 버전"
          value={minAppVersion}
          valueStyle={{ color: color.accentDeep }}
        />
      </Tile>
    </PhoneScreen>
  );
}
