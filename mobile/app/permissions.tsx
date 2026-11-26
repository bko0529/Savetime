/**
 * 권한 확인 (SFR-092): 위치 → 알림 순서로, 권한마다 이유 한 줄.
 * Lovable(웹)은 허용한 것처럼 표시만 했지만, 여기서는 휴대폰의 진짜 권한 창을 띄운다.
 * - 위치를 거부하면 다음으로 못 넘어가고 '설정으로 이동' 만 보여 준다
 * - 알림은 거부해도 넘어가지만 경고를 보여 준다
 * - 전화는 tel: 로 전화 앱을 열기만 해서 권한을 묻지 않는다
 */
import { Bell, Check, MapPin, Settings2, X, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import {
  openSettings,
  requestLocation,
  requestNotify,
  usePermissions,
  type Perm,
} from '../src/state/permissions';
import {
  BigButton,
  CenterMessage,
  IconTile,
  iconColor,
  Notice,
  PhoneScreen,
  Pill,
  Tile,
  Txt,
} from '../src/ui/kit';
import { color, text } from '../src/ui/theme';

type K = 'location' | 'notify';
const ROWS: { k: K; icon: LucideIcon; title: string; why: string }[] = [
  {
    k: 'location',
    icon: MapPin,
    title: '위치 (필수)',
    why: "반경 안 병원에 요청하고 도착 예상 시간을 계산해요. '앱 사용 중'에만 써요",
  },
  {
    k: 'notify',
    icon: Bell,
    title: '알림',
    why: `병원 승인을 소리 · 진동으로 바로 알려요${Platform.OS === 'ios' ? '. 무음 모드에서는 소리 없이 진동으로만 알려요' : ''}`,
  },
];

export default function PermissionsScreen() {
  const p = usePermissions();
  const [busy, setBusy] = useState(false);

  // 권한 창은 휴대폰이 띄운다. 이미 거부한 권한은 다시 창이 안 뜨므로 그때는 설정 앱으로
  const ask = async (k: K) => {
    setBusy(true);
    try {
      await (k === 'location' ? requestLocation() : requestNotify());
    } finally {
      setBusy(false);
    }
  };

  if (p.location === 'denied') {
    return (
      <PhoneScreen
        title="권한 확인"
        footer={
          p.locationCanAsk ? (
            <BigButton size="lg" busy={busy} onPress={() => void ask('location')}>
              다시 허용하기
            </BigButton>
          ) : (
            <BigButton
              size="lg"
              onPress={() => void openSettings()}
              icon={<Settings2 size={20} color={color.primaryText} />}
            >
              설정으로 이동
            </BigButton>
          )
        }
      >
        <CenterMessage
          icon={<MapPin size={28} color={color.warning} />}
          title="위치 권한이 있어야 사용할 수 있어요"
          body="설정에서 위치를 '앱 사용 중 허용'으로 바꿔 주세요"
        />
      </PhoneScreen>
    );
  }

  const next = ROWS.find((r) => p[r.k] === 'unknown');
  const done = ROWS.filter((r) => p[r.k] === 'granted' || p[r.k] === 'denied').length;

  return (
    <PhoneScreen
      title="권한 확인"
      subtitle="필요한 이유를 보고 허용해 주세요"
      badge={
        <Pill tone="neutral" dot={false}>
          {`${done}/${ROWS.length}`}
        </Pill>
      }
      footer={
        next ? (
          <BigButton size="lg" busy={busy} onPress={() => void ask(next.k)}>
            {next.k === 'location' ? '앱 사용 중 허용' : '허용'}
          </BigButton>
        ) : undefined
      }
    >
      <View style={{ gap: 10 }}>
        {ROWS.map(({ k, icon: Icon, title, why }) => {
          const on = next?.k === k;
          const tone = p[k] === 'granted' ? 'ok' : on ? 'accent' : 'ink';
          return (
            <Tile
              key={k}
              style={[
                { flexDirection: 'row', alignItems: 'flex-start', gap: 14, padding: 16 },
                on && { borderWidth: 2, borderColor: color.accent, backgroundColor: '#FFF6F4' },
              ]}
            >
              <IconTile tone={tone}>
                <Icon size={20} color={iconColor(tone)} />
              </IconTile>
              <View style={{ flex: 1 }}>
                <Txt style={text.strong}>{title}</Txt>
                <Txt style={[text.caption, { marginTop: 4, color: color.muted }]}>{why}</Txt>
              </View>
              <StatusPill perm={p[k]} on={on} />
            </Tile>
          );
        })}
      </View>
      {p.notify === 'denied' ? (
        <View style={{ marginTop: 16 }}>
          <Notice tone="warn">
            알림을 끄면 병원 승인을 화면을 볼 때만 알 수 있어요. 설정에서 다시 켤 수 있어요
          </Notice>
        </View>
      ) : null}
      <Txt style={[text.caption, { marginTop: 20, color: color.muted }]}>
        위치는 &apos;앱 사용 중&apos;에만 쓰고, 백그라운드 위치 권한은 여기서 묻지 않아요. 카메라는
        공무원증 촬영 · QR 스캔 때 물어요.
      </Txt>
    </PhoneScreen>
  );
}

function StatusPill({ perm, on }: { perm: Perm; on: boolean }) {
  if (perm === 'granted')
    return (
      <Pill tone="ok" icon={<Check size={12} color={color.success} />}>
        허용함
      </Pill>
    );
  if (perm === 'denied')
    return (
      <Pill tone="neutral" icon={<X size={12} color={color.muted} />}>
        허용 안 함
      </Pill>
    );
  if (on) return <Pill tone="wait">지금</Pill>;
  return (
    <Pill tone="neutral" dot={false}>
      다음
    </Pill>
  );
}
