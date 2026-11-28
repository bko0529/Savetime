/**
 * 승인 대기 (SFR-022) · 반려 (SFR-083). 승인 전에는 이 화면만 쓸 수 있다.
 * 승인되면 서버가 알려 준다(실시간·푸시는 4·9단계). 그 전에는 '지금 결과 다시 확인' 과 앱을 다시 열 때 확인한다.
 */
import { useRouter } from 'expo-router';
import { BellRing, Hourglass, Lock, XCircle } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useAuth } from '../src/auth/AuthProvider';
import { REJECT_LABEL, ymdhm } from '../src/auth/statusMessage';
import {
  BigButton,
  CenterMessage,
  KeyVal,
  Notice,
  PhoneScreen,
  Pill,
  Tile,
  Txt,
} from '../src/ui/kit';
import { color, font, text } from '../src/ui/theme';

export default function PendingScreen() {
  const { state, refreshMe, logout } = useAuth();
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  if (state.status !== 'signedIn') return null;
  const me = state.me;
  const rejected = me.status === 'rejected';
  const suspended = me.status === 'suspended';
  const reason = me.rejectReason
    ? (REJECT_LABEL[me.rejectReason] ?? me.rejectReason)
    : '관리자에게 문의해 주세요';

  const check = async () => {
    setChecking(true);
    await refreshMe();
    setChecking(false);
  };

  return (
    <PhoneScreen
      title={rejected ? '가입이 반려됐어요' : suspended ? '이용이 정지됐어요' : '승인 대기 중'}
      subtitle={
        rejected
          ? '내용을 고쳐 다시 신청해 주세요'
          : suspended
            ? '소속 관리자에게 문의해 주세요'
            : '승인 전에는 다른 기능을 쓸 수 없어요'
      }
      footer={
        <>
          {rejected ? (
            <BigButton size="lg" onPress={() => router.push('/signup')}>
              다시 가입 신청
            </BigButton>
          ) : null}
          <BigButton variant="outline" onPress={() => void logout()}>
            로그아웃
          </BigButton>
        </>
      }
    >
      {rejected ? (
        <CenterMessage icon={<XCircle size={28} color={color.destructive} />} title={reason} />
      ) : suspended ? (
        <CenterMessage
          icon={<Lock size={28} color={color.warning} />}
          title="이 계정은 지금 쓸 수 없어요"
        />
      ) : (
        <View>
          <CenterMessage
            icon={<Hourglass size={28} color={color.warning} />}
            title="관리자가 공무원증을 확인하고 있어요"
          />
          <View
            style={{
              marginTop: -40,
              marginBottom: 32,
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <BellRing size={14} color={color.muted} />
            <Txt style={[text.body, { color: color.muted }]}>승인되면 알림으로 알려드려요</Txt>
          </View>
        </View>
      )}

      {rejected ? (
        <View style={{ marginBottom: 16 }}>
          <Notice tone="warn">반려 사유: {reason}</Notice>
        </View>
      ) : null}

      <Tile divided>
        <KeyVal label="신청 일시" value={ymdhm(me.appliedAt)} />
        <KeyVal label="이름" value={`${me.name ?? ''} ${me.rank ?? ''}`.trim()} />
        <KeyVal label="소속" value={[me.agency, me.safetyCenter].filter(Boolean).join(' · ')} />
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
          {rejected ? (
            <Pill tone="danger">반려</Pill>
          ) : suspended ? (
            <Pill tone="neutral">정지</Pill>
          ) : (
            <Pill tone="wait">확인 중</Pill>
          )}
        </View>
      </Tile>

      {!rejected && !suspended ? (
        <Pressable
          onPress={() => void check()}
          disabled={checking}
          accessibilityRole="button"
          style={{ marginTop: 28, padding: 8 }}
        >
          <Txt
            style={{
              textAlign: 'center',
              fontFamily: font.semibold,
              fontSize: 12,
              color: color.muted,
              textDecorationLine: 'underline',
            }}
          >
            {checking ? '확인 중…' : '지금 결과 다시 확인'}
          </Txt>
        </Pressable>
      ) : null}
    </PhoneScreen>
  );
}
