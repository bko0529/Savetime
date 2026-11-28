/**
 * 시작하기 · 위치정보 수집·이용 안내 (SFR-041, 필수 동의). 문구는 Lovable welcome 화면 그대로.
 * 동의는 휴대폰에만 저장한다. 동의하지 않으면 앱을 쓸 수 없다.
 */
import {
  Clock,
  Hospital,
  MapPin,
  MapPinOff,
  Navigation,
  Send,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react-native';
import { View } from 'react-native';
import { consentStore, setConsent } from '../src/state/consent';
import { useStore } from '../src/state/store';
import { BigButton, CenterMessage, IconTile, PhoneScreen, Tile, Txt } from '../src/ui/kit';
import { color, font, radius, text } from '../src/ui/theme';

const ITEMS: { k: string; v: string; icon: LucideIcon }[] = [
  {
    k: '수집 목적',
    v: '이송 요청 · 도착 예상 시간 계산, 구급활동일지 이동 거리 기록, 구급차 경로 안내 개선을 위한 익명 경로 축적',
    icon: ShieldCheck,
  },
  { k: '보관 항목', v: '이송 중 구급차 위치 기록 (좌표 · 시각)', icon: MapPin },
  {
    k: '보관 기간',
    v: "도착 · 취소하면 바로 대원 계정 · 팀 · 이송 건과의 연결을 끊고 '익명 이송 경로'로 바꿔 3년 보관해요. 이송 기록에는 이동 거리만 남아요",
    icon: Clock,
  },
  {
    k: '병원 제공',
    v: '환자 평가 정보와, 위치로 계산한 도착 예상 시간을 요청 대상 병원에 보내요',
    icon: Hospital,
  },
  {
    k: '길찾기 서비스',
    v: '경로 안내 · 이동 시간 계산을 위해 위치가 카카오모빌리티에 전달돼요',
    icon: Navigation,
  },
];

export default function WelcomeScreen() {
  const { consent } = useStore(consentStore);

  if (consent === 'refused') {
    return (
      <PhoneScreen
        title="골든타임즈"
        footer={
          <BigButton size="lg" onPress={() => void setConsent('unknown')}>
            다시 동의하기
          </BigButton>
        }
      >
        <CenterMessage
          icon={<MapPinOff size={28} color={color.warning} />}
          title="위치 동의가 있어야 사용할 수 있어요"
        />
      </PhoneScreen>
    );
  }

  return (
    <PhoneScreen
      title="골든타임즈 시작하기"
      subtitle="위치정보 수집 · 이용 안내 (필수)"
      footer={
        <>
          <BigButton size="lg" onPress={() => void setConsent('agreed')}>
            동의하고 계속
          </BigButton>
          <BigButton variant="outline" onPress={() => void setConsent('refused')}>
            동의 안 함
          </BigButton>
        </>
      }
    >
      <Tile style={{ flexDirection: 'row', gap: 12, padding: 16, marginBottom: 20 }}>
        <IconTile tone="accent">
          <MapPin size={20} color={color.accentDeep} />
        </IconTile>
        <Txt style={[text.body, { flex: 1, paddingTop: 2, color: color.muted }]}>
          병상 숫자가 아니라, <Txt style={{ fontFamily: font.bold }}>병원의 대답</Txt>을 봅니다.
          {'\n'}119 구급대원 전용 이송 요청 앱이에요.
        </Txt>
      </Tile>

      <Tile divided>
        {ITEMS.map(({ k, v, icon: Icon }, i) => (
          <View key={k} style={{ flexDirection: 'row', gap: 14, padding: 16 }}>
            <IconTile tone="ink" size={32}>
              <Txt style={{ fontFamily: font.extrabold, fontSize: 12, color: color.primary }}>
                {i + 1}
              </Txt>
            </IconTile>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon size={14} color={color.muted} />
                <Txt style={text.strong}>{k}</Txt>
              </View>
              <Txt style={[text.small, { marginTop: 4, color: color.muted }]}>{v}</Txt>
            </View>
          </View>
        ))}
      </Tile>

      <View
        style={{
          marginTop: 16,
          padding: 16,
          borderRadius: radius.md,
          backgroundColor: color.surface,
        }}
      >
        <Txt style={text.strong}>왜 필수인가요?</Txt>
        <Txt style={[text.small, { marginTop: 6, color: color.muted }]}>
          위치가 있어야 반경 안 병원에 요청을 보내고 도착 예상 시간을 계산할 수 있어요. 그래서
          동의해야 앱을 쓸 수 있어요.
        </Txt>
      </View>
      <View style={{ marginTop: 16, flexDirection: 'row', gap: 6 }}>
        <Send size={14} color={color.muted} style={{ marginTop: 2 }} />
        <Txt style={[text.caption, { flex: 1, color: color.muted }]}>
          본 서비스는 참고용이며 의료 판단과 병원 수용을 보장하지 않습니다.
        </Txt>
      </View>
    </PhoneScreen>
  );
}
