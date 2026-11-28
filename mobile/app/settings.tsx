/**
 * 설정 (Lovable settings 그대로): 근무 · 권한 · 계정 · 이 기기.
 * 근무 종료 · 로그아웃 · 회원 탈퇴는 한 번 더 묻는다 (SFR-070 · 071 · 113).
 * - 진행 중 이송이 있으면 알려 주고, 팀에 나만 남았으면 이송이 '취소'로 끝난다고 미리 말한다
 * - 근무 종료 = 로그아웃 (서버에서 같은 처리). 근무 시작 후 14시간이 지나면 서버가 자동으로 끝낸다
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { useAuth, type LeaveKind } from '../src/auth/AuthProvider';
import { fromServerRole, teamStore } from '../src/duty/team';
import { setConsent } from '../src/state/consent';
import { openSettings, usePermissions } from '../src/state/permissions';
import { useStore } from '../src/state/store';
import { setThemePref, useThemePref } from '../src/ui/themePref';
import { hhmm } from '../src/journal/form';
import { useEngine } from '../src/transport/engine';
import { isActive } from '../src/transport/types';
import {
  BigButton,
  KeyVal,
  Notice,
  PhoneScreen,
  Pill,
  SectionTitle,
  Segmented,
  Tile,
  Txt,
} from '../src/ui/kit';
import { color, font, text } from '../src/ui/theme';

const KIND_LABEL: Record<LeaveKind, string> = {
  duty_end: '근무 종료',
  logout: '로그아웃',
  withdrawal: '회원 탈퇴',
};
const SHIFT_MAX_MS = 14 * 60 * 60_000;

export default function SettingsScreen() {
  const { state, leave } = useAuth();
  const router = useRouter();
  const t = useStore(teamStore);
  const e = useEngine();
  const perm = usePermissions();
  const themePref = useThemePref();
  const [ask, setAsk] = useState<LeaveKind | null>(null);
  const [busy, setBusy] = useState(false);
  if (state.status !== 'signedIn') return null;
  const me = state.me;
  const team = t.team === 'loading' ? null : t.team;
  const myRole = fromServerRole(team?.members?.find((m) => m.isMe)?.role);
  const active = isActive(e.status);
  const last = (team?.members?.length ?? 1) <= 1;
  const permLabel = (v: string, on: string) => (v === 'granted' ? on : '꺼짐');

  const go = async () => {
    if (!ask) return;
    const kind = ask;
    setBusy(true);
    const err = await leave(kind);
    setBusy(false);
    setAsk(null);
    if (err) Alert.alert(`${KIND_LABEL[kind]}하지 못했어요`, err);
  };

  const row = (label: string, onPress: () => void, danger = false) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ paddingHorizontal: 16, paddingVertical: 14 }}
    >
      <Txt
        style={{
          fontFamily: font.bold,
          fontSize: 14,
          color: danger ? color.destructive : color.foreground,
        }}
      >
        {label}
      </Txt>
    </Pressable>
  );

  return (
    <PhoneScreen
      title="설정"
      subtitle={`${me.name ?? ''} ${me.rank ?? ''} · ${me.agency ?? ''} ${me.safetyCenter ?? ''}`}
      footer={
        <BigButton variant="outline" onPress={() => router.back()}>
          ← 홈으로
        </BigButton>
      }
    >
      {ask ? (
        <View
          style={{
            marginBottom: 20,
            gap: 12,
            padding: 16,
            borderRadius: 12,
            borderWidth: 2,
            borderColor: 'rgba(185,28,30,0.4)',
            backgroundColor: 'rgba(185,28,30,0.05)',
          }}
          accessibilityRole="alert"
        >
          <Txt style={{ fontFamily: font.extrabold, fontSize: 16, color: color.destructive }}>
            {KIND_LABEL[ask]}할까요?
          </Txt>
          {active ? <Notice tone="warn">진행 중 이송 1건이 있어요</Notice> : null}
          <Txt style={[text.body, { color: color.muted }]}>
            {active && last
              ? `팀에 나만 남아 있어서, 진행 중 이송을 '취소'(사유: ${KIND_LABEL[ask]})로 끝내요. `
              : ''}
            {ask === 'withdrawal'
              ? '계정 · 프로필 정보가 바로 삭제되고 되돌릴 수 없어요.'
              : '나만 팀에서 빠지고 다음에 다시 로그인해야 해요.'}
          </Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <BigButton variant="outline" style={{ flex: 1 }} onPress={() => setAsk(null)}>
              아니요
            </BigButton>
            <BigButton
              variant="danger"
              style={{ flex: 1 }}
              busy={busy}
              onPress={() => void go()}
              accessibilityLabel={`${KIND_LABEL[ask]} 확인`}
            >
              {KIND_LABEL[ask]}
            </BigButton>
          </View>
        </View>
      ) : null}

      <SectionTitle
        first
        hint="근무 종료 = 로그아웃이에요. 근무 시작 후 14시간이 지나면 자동으로 끝나요"
      >
        근무
      </SectionTitle>
      <Tile divided>
        <KeyVal label="팀 코드" value={team?.code ?? '-'} valueStyle={{ letterSpacing: 4 }} />
        <KeyVal label="내 역할" value={myRole} />
        <KeyVal label="팀원" value={`${team?.members?.length ?? 1}명`} />
        {t.startedAt ? (
          <KeyVal
            label="근무 시간"
            value={`${hhmm(t.startedAt)} 시작 · ${hhmm(t.startedAt + SHIFT_MAX_MS)} 자동 종료`}
          />
        ) : null}
        {row('근무 종료', () => setAsk('duty_end'), true)}
      </Tile>

      <SectionTitle hint="야간 구급차 안에서 눈부시지 않게 어둡게 할 수 있어요">화면</SectionTitle>
      <Tile style={{ padding: 12 }}>
        <Segmented
          value={themePref}
          onChange={setThemePref}
          options={[
            { value: 'system', label: '휴대폰 설정' },
            { value: 'light', label: '밝게' },
            { value: 'dark', label: '어둡게' },
          ]}
        />
      </Tile>

      <SectionTitle>권한</SectionTitle>
      <Tile divided>
        <KeyVal label="위치" value={permLabel(perm.location, '앱 사용 중 허용')} />
        <KeyVal label="알림" value={permLabel(perm.notify, '허용')} />
        {row('휴대폰 설정에서 바꾸기', () => void openSettings())}
      </Tile>

      <SectionTitle>계정</SectionTitle>
      <Tile divided>
        <KeyVal
          label="소속"
          value={[me.agency, me.safetyCenter].filter(Boolean).join(' · ') || '-'}
        />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          <Txt style={[text.body, { color: color.muted }]}>상태</Txt>
          <Pill tone="ok">승인됨</Pill>
        </View>
        {row('비밀번호 바꾸기', () => router.push('/password'))}
        {row('로그아웃', () => setAsk('logout'))}
        {row('회원 탈퇴', () => setAsk('withdrawal'), true)}
      </Tile>

      <SectionTitle hint="이 기기에 남은 위치 동의 기록까지 지우고 처음 쓰는 날 화면부터 다시 봐요">
        이 기기
      </SectionTitle>
      <Tile divided>
        <Pressable
          onPress={() =>
            Alert.alert(
              '처음 쓰는 날부터 다시 볼까요?',
              '로그아웃하고 위치 동의부터 다시 물어요.',
              [
                { text: '아니요', style: 'cancel' },
                {
                  text: '다시 보기',
                  onPress: () => void leave('logout').then(() => setConsent('unknown')),
                },
              ],
            )
          }
          accessibilityRole="button"
          accessibilityLabel="로그아웃하고 처음 쓰는 날부터 다시 보기"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          <Txt style={[text.body, { flex: 1, color: color.muted }]}>
            로그아웃하고 처음 쓰는 날부터 다시 보기
          </Txt>
          <Pill tone="neutral" dot={false}>
            시연
          </Pill>
        </Pressable>
      </Tile>
    </PhoneScreen>
  );
}
