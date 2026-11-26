/**
 * 가입 신청 (SFR-017) · 반려 후 다시 신청 (SFR-083). 구성·문구는 Lovable signup 화면 그대로.
 * 소속 소방서 코드 · 안전센터 · 이름 · 계급 · 사번 · (아이디 · 비밀번호) · 공무원증 사진 + 사진 동의 → 관리자 승인.
 * 다시 신청할 때는 같은 계정이라 아이디·비밀번호를 묻지 않는다.
 */
import { useRouter } from 'expo-router';
import { Camera, Check, ChevronLeft, ImageIcon } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { useAuth } from '../src/auth/AuthProvider';
import { pickPhoto } from '../src/auth/pickPhoto';
import { passwordOk, RANKS, signupError, type SignupForm } from '../src/auth/signupForm';
import {
  BigButton,
  CheckRow,
  Chips,
  Field,
  IconTile,
  Label,
  Notice,
  PhoneScreen,
  SectionTitle,
  Txt,
} from '../src/ui/kit';
import { color, font, radius, text } from '../src/ui/theme';

const EMPTY: SignupForm = {
  agencyCode: '',
  safetyCenter: '',
  name: '',
  rank: '소방교',
  employeeNo: '',
  loginId: '',
  password: '',
  password2: '',
  photo: null,
  photoConsent: false,
};

export default function SignupScreen() {
  const { state, signup } = useAuth();
  const router = useRouter();
  const [f, setF] = useState<SignupForm>(EMPTY);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SignupForm>(k: K, v: SignupForm[K]) =>
    setF((p) => ({ ...p, [k]: v }));
  const reapply = state.status === 'signedIn' && state.me.status === 'rejected';

  const choose = async (source: 'camera' | 'library') => {
    const r = await pickPhoto(source);
    if (!r) return; // 취소
    if ('error' in r) return setErr(r.error);
    set('photo', r.photo);
    setErr('');
  };

  const submit = async () => {
    if (busy) return;
    const e = signupError(f, reapply);
    if (e) return setErr(e);
    // 소방서 코드가 맞는지·아이디가 겹치는지는 서버가 보고 문구를 돌려준다. 통과하면 '승인 대기' 화면으로 바뀐다
    setBusy(true);
    setErr((await signup(f)) ?? '');
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <PhoneScreen
        title="가입 신청"
        subtitle="관리자가 공무원증을 확인하고 승인해요"
        footer={
          <BigButton size="lg" busy={busy} onPress={() => void submit()}>
            {reapply ? '다시 신청' : '가입 신청'}
          </BigButton>
        }
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            marginTop: -4,
            marginBottom: 16,
          }}
        >
          <ChevronLeft size={16} color={color.muted} />
          <Txt style={{ fontFamily: font.semibold, fontSize: 14, color: color.muted }}>
            {reapply ? '돌아가기' : '로그인으로'}
          </Txt>
        </Pressable>

        <SectionTitle first hint="소방서 단위 코드예요. 모르면 소속 관리자에게 물어보세요">
          <Step n={1}>소속 소방서</Step>
        </SectionTitle>
        <Field
          value={f.agencyCode}
          onChangeText={(v) => set('agencyCode', v.toUpperCase())}
          placeholder="CN-SB-019"
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel="소속 소방서 코드"
        />
        <View style={{ marginTop: 12 }}>
          <Label>소속 안전센터</Label>
          <Field
            value={f.safetyCenter}
            onChangeText={(v) => set('safetyCenter', v)}
            placeholder="서북119안전센터"
            accessibilityLabel="소속 안전센터"
          />
        </View>

        <SectionTitle>
          <Step n={2}>내 정보</Step>
        </SectionTitle>
        <Label>이름</Label>
        <Field
          value={f.name}
          onChangeText={(v) => set('name', v)}
          placeholder="김도윤"
          accessibilityLabel="이름"
        />
        <View style={{ marginTop: 12 }}>
          <Label>계급</Label>
          <Chips
            value={f.rank as (typeof RANKS)[number]}
            options={RANKS}
            onChange={(v) => set('rank', v)}
          />
        </View>
        <View style={{ marginTop: 12 }}>
          <Label>사번</Label>
          <Field
            value={f.employeeNo}
            onChangeText={(v) => set('employeeNo', v)}
            placeholder="2019-1234"
            keyboardType="numbers-and-punctuation"
            accessibilityLabel="사번"
          />
        </View>

        {!reapply ? (
          <>
            <SectionTitle>
              <Step n={3}>로그인 정보</Step>
            </SectionTitle>
            <Label>아이디 (영문 · 숫자 · . _ - 4~40자)</Label>
            <Field
              value={f.loginId}
              onChangeText={(v) => set('loginId', v)}
              placeholder="kimdoyun"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username-new"
              textContentType="username"
              accessibilityLabel="아이디"
            />
            <View style={{ marginTop: 12, flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Label>비밀번호</Label>
                <Field
                  value={f.password}
                  onChangeText={(v) => set('password', v)}
                  secureTextEntry
                  autoComplete="new-password"
                  textContentType="newPassword"
                  accessibilityLabel="비밀번호"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Label>비밀번호 확인</Label>
                <Field
                  value={f.password2}
                  onChangeText={(v) => set('password2', v)}
                  secureTextEntry
                  autoComplete="new-password"
                  textContentType="newPassword"
                  accessibilityLabel="비밀번호 확인"
                />
              </View>
            </View>
            <Txt
              style={{
                marginTop: 8,
                fontFamily: font.semibold,
                fontSize: 12,
                color: f.password && passwordOk(f.password) ? color.success : color.muted,
              }}
            >
              8자 이상, 영문과 숫자를 섞어 주세요
            </Txt>
          </>
        ) : null}

        <SectionTitle hint="관리자만 볼 수 있고, 확인이 끝나면 삭제돼요">
          <Step n={reapply ? 3 : 4}>공무원증 사진</Step>
        </SectionTitle>
        {f.photo ? (
          <View
            style={[
              photoBox,
              { borderColor: 'rgba(0,125,101,0.5)', backgroundColor: 'rgba(215,247,237,0.4)' },
            ]}
          >
            <Check size={16} color={color.success} />
            <Txt
              style={{ fontFamily: font.bold, fontSize: 14, color: color.success }}
              numberOfLines={1}
            >
              {f.photo.name}
            </Txt>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: f.photo ? 8 : 0 }}>
          <Pressable
            style={[photoBox, { flex: 1 }]}
            onPress={() => void choose('camera')}
            accessibilityRole="button"
          >
            <Camera size={20} color={color.accentDeep} />
            <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>
              {f.photo ? '다시 촬영' : '촬영하기'}
            </Txt>
          </Pressable>
          <Pressable
            style={[photoBox, { flex: 1 }]}
            onPress={() => void choose('library')}
            accessibilityRole="button"
          >
            <ImageIcon size={20} color={color.accentDeep} />
            <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>앨범에서 선택</Txt>
          </Pressable>
        </View>
        <Txt style={[text.caption, { marginTop: 6, color: color.muted }]}>
          카메라 권한은 이때 물어요
        </Txt>

        <View style={{ marginTop: 16 }}>
          <CheckRow checked={f.photoConsent} onChange={(v) => set('photoConsent', v)}>
            <Txt style={text.body}>
              공무원증 사진 수집 · 이용에 동의합니다{' '}
              <Txt style={{ fontFamily: font.bold, color: color.accentDeep }}>(필수)</Txt>
            </Txt>
          </CheckRow>
        </View>
        {err ? (
          <View style={{ marginTop: 16 }}>
            <Notice tone="warn">{err}</Notice>
          </View>
        ) : null}
      </PhoneScreen>
    </KeyboardAvoidingView>
  );
}

const photoBox = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: 8,
  padding: 20,
  borderRadius: radius.lg,
  borderWidth: 1,
  borderStyle: 'dashed' as const,
  borderColor: color.borderStrong,
  backgroundColor: color.card,
};

function Step({ n, children }: { n: number; children: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <IconTile tone="accent" size={20}>
        <Txt style={{ fontFamily: font.extrabold, fontSize: 11, color: color.accentDeep }}>{n}</Txt>
      </IconTile>
      <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>{children}</Txt>
    </View>
  );
}
