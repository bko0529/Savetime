/**
 * 받은 팀 초대 (SFR-159). 구성·문구는 Lovable invite 화면 그대로.
 * 초대는 실시간 이벤트로 온다. 남은 시간은 서버 시각 기준으로 센다. 수락하면 그 팀으로 바로 근무 시작.
 */
import { useRouter } from 'expo-router';
import { BellRing, Check, Clock, Users, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { serverNow } from '../src/api/client';
import {
  acceptInvite,
  declineInvite,
  inviteLeft,
  teamStore,
  type Incoming,
  type Role,
} from '../src/duty/team';
import { useStore } from '../src/state/store';
import {
  Avatar,
  BigButton,
  CenterMessage,
  Notice,
  PhoneScreen,
  Pill,
  SectionTitle,
  Tile,
  Txt,
} from '../src/ui/kit';
import { color, font, radius, text } from '../src/ui/theme';

const mmss = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

export default function InviteScreen() {
  const router = useRouter();
  const { incoming } = useStore(teamStore);
  const [now, setNow] = useState(serverNow());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  // 초대 받는 쪽 역할은 처치로 들어간다. 운전으로 바꾸려면 근무 시작 화면에서 (운전은 팀에 1명)
  const role: Role = '처치';

  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(id);
  }, []);

  const live = incoming.filter((i) => inviteLeft(i, now) > 0);

  const accept = async (inv: Incoming) => {
    setBusy(inv.inviteId);
    const e = await acceptInvite(inv, role);
    setBusy(null);
    if (e) return setErr(e);
    // 수락하면 근무가 시작돼 화면 순서(gate)가 홈으로 옮긴다
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/duty'));

  if (live.length === 0) {
    return (
      <PhoneScreen
        title="팀 초대"
        subtitle="지금 온 초대가 없어요"
        footer={
          <BigButton variant="outline" onPress={back}>
            근무 시작으로
          </BigButton>
        }
      >
        <CenterMessage
          tone="ink"
          icon={<BellRing size={24} color={color.primary} />}
          title="대기 중인 초대가 없어요"
        />
        <Notice tone="info">
          초대는 초대받은 대원의 폰에 &apos;팀 초대&apos; 알림으로 와요. 5분 안에 수락해야 팀에
          들어갈 수 있어요.
        </Notice>
      </PhoneScreen>
    );
  }

  return (
    <PhoneScreen
      title="팀 초대"
      subtitle={`${live.length}건 · 5분 안에 답해야 해요`}
      badge={
        <Pill tone="wait" dot={false}>
          답변 필요
        </Pill>
      }
      footer={
        <BigButton variant="outline" onPress={back}>
          근무 시작으로
        </BigButton>
      }
    >
      {live.map((inv) => {
        const left = inviteLeft(inv, now);
        const soon = left <= 60_000;
        return (
          <Tile key={inv.inviteId} style={{ marginBottom: 12, overflow: 'hidden' }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 16,
                paddingVertical: 10,
                backgroundColor: color.surface,
                borderBottomWidth: 1,
                borderBottomColor: color.border,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <BellRing size={14} color={color.muted} />
                <Txt style={{ fontFamily: font.bold, fontSize: 11, color: color.muted }}>
                  팀 초대
                </Txt>
              </View>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 999,
                  backgroundColor: soon ? color.destructive : color.warningSoft,
                }}
              >
                <Clock size={12} color={soon ? color.accentText : color.warning} />
                <Txt
                  style={{
                    fontFamily: font.extrabold,
                    fontSize: 12,
                    color: soon ? color.accentText : color.warning,
                  }}
                >
                  {mmss(left)} 뒤 만료
                </Txt>
              </View>
            </View>
            <View style={{ padding: 16, gap: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Avatar name={inv.fromName} />
                <View style={{ flex: 1 }}>
                  <Txt style={text.strong}>{inv.fromName}</Txt>
                  <Txt style={[text.caption, { color: color.muted }]}>같은 소방서 대원</Txt>
                </View>
              </View>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-end',
                  justifyContent: 'space-between',
                  padding: 14,
                  borderRadius: radius.md,
                  backgroundColor: color.surface,
                }}
              >
                <View>
                  <Txt style={{ fontFamily: font.bold, fontSize: 11, color: color.muted }}>
                    들어갈 팀
                  </Txt>
                  <Txt
                    style={{
                      marginTop: 4,
                      fontFamily: font.extrabold,
                      fontSize: 30,
                      lineHeight: 34,
                      letterSpacing: 6,
                    }}
                  >
                    {inv.teamCode}
                  </Txt>
                </View>
                <Pill tone="call" dot={false}>
                  내 역할 {role}
                </Pill>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Users size={14} color={color.muted} style={{ marginTop: 2 }} />
                <Txt style={[text.caption, { flex: 1, color: color.muted }]}>
                  수락하면 이 대원과 한 팀이 돼요. 팀은 최대 4명 · 운전은 1명이고, 이미 운전 대원이
                  있으면 내 역할은 처치로 들어가요.
                </Txt>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <BigButton
                  size="lg"
                  style={{ flex: 1 }}
                  busy={busy === inv.inviteId}
                  onPress={() => void accept(inv)}
                  icon={<Check size={20} color={color.primaryText} />}
                  accessibilityLabel="수락"
                >
                  수락
                </BigButton>
                <BigButton
                  size="lg"
                  variant="outline"
                  style={{ flex: 1 }}
                  onPress={() => void declineInvite(inv)}
                  icon={<X size={20} color={color.foreground} />}
                  accessibilityLabel="거절"
                >
                  거절
                </BigButton>
              </View>
            </View>
          </Tile>
        );
      })}
      {err ? <Notice tone="warn">{err}</Notice> : null}
      <SectionTitle hint="5분 안에 답하지 않으면 초대가 만료되고, 초대한 대원 화면에도 그 사실이 보여요">
        알림으로 도착
      </SectionTitle>
    </PhoneScreen>
  );
}
