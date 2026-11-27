/**
 * S-02 로그인 (SFR-018, SER-011). 화면 구성·문구는 Lovable login 화면 그대로.
 * 아이디·비밀번호만 받는다. 근무 동안은 앱을 다시 열어도 로그인을 묻지 않는다.
 * 틀린 횟수·잠금은 서버가 판단하고 문구도 서버가 준다 → 앱은 그 문구를 그대로 보여 준다.
 */
import { ChevronRight, UserPlus } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/auth/AuthProvider';
import { checkLoginForm } from '../src/auth/loginForm';
import { BigButton, EcgLine, IconTile, Label, LogoMark, Notice, Tile, Txt } from '../src/ui/kit';
import { color, font, onSchemeChange, radius, shadow, text } from '../src/ui/theme';

export default function LoginScreen() {
  const { state, login } = useAuth();
  const router = useRouter();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notice = state.status === 'signedOut' ? state.notice : undefined;

  const submit = async () => {
    if (busy) return; // 두 번 눌러도 요청은 한 번
    const checked = checkLoginForm({ loginId, password });
    if (!checked.ok) return setError(checked.message);
    setBusy(true);
    setError(await login(checked.value.loginId, checked.value.password));
    setBusy(false);
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
          <View style={s.ecg} pointerEvents="none">
            <EcgLine width={208} opacity={0.4} />
          </View>
          <View style={[s.logo, shadow.card]}>
            <LogoMark size={44} />
          </View>
          <Txt style={s.eyebrow}>119 구급대원 전용</Txt>
          <Txt style={s.title}>골든타임즈</Txt>
          <Txt style={[text.body, { marginTop: 6, color: color.muted }]}>
            병원 승인 후 출발하는 이송
          </Txt>

          <Tile style={s.card}>
            {notice && !error ? <Notice tone="warn">{notice}</Notice> : null}
            <View>
              <Label>아이디</Label>
              <TextInput
                style={s.input}
                value={loginId}
                onChangeText={setLoginId}
                placeholder="kimdoyun"
                placeholderTextColor={color.borderStrong}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                returnKeyType="next"
                accessibilityLabel="아이디"
              />
            </View>
            <View>
              <Label>비밀번호</Label>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={color.borderStrong}
                secureTextEntry
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
                accessibilityLabel="비밀번호"
              />
            </View>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <BigButton
              size="lg"
              busy={busy}
              onPress={() => void submit()}
              accessibilityLabel="로그인"
            >
              로그인
            </BigButton>
            <Txt style={[text.caption, { textAlign: 'center', color: color.muted }]}>
              근무 중에는 앱을 다시 열어도 로그인을 묻지 않아요
            </Txt>
          </Tile>

          <Pressable
            onPress={() => router.push('/signup')}
            accessibilityRole="button"
            accessibilityLabel="가입 신청"
          >
            <Tile style={s.signup}>
              <IconTile tone="accent" size={40}>
                <UserPlus size={20} color={color.accentDeep} />
              </IconTile>
              <View style={{ flex: 1 }}>
                <Txt style={{ fontFamily: font.bold, fontSize: 15 }}>처음이세요? 가입 신청</Txt>
                <Txt style={[text.caption, { marginTop: 2, color: color.muted }]}>
                  이름 · 소속 소방서 · 공무원증으로 신청해요
                </Txt>
              </View>
              <ChevronRight size={16} color={color.muted} />
            </Tile>
          </Pressable>

          <Txt style={[text.caption, s.footer]}>
            비밀번호를 잊으면 소속 관리자에게 초기화를 요청하세요 · 5번 틀리면 10분 동안 잠겨요
          </Txt>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// 테마가 바뀌면 다시 만든다 (QUR-005)
let s = makeStyles();
onSchemeChange(() => {
  s = makeStyles();
});
function makeStyles() {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: color.background },
    wrap: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 40, paddingBottom: 24 },
    ecg: { position: 'absolute', right: 0, top: 72 },
    logo: {
      width: 64,
      height: 64,
      borderRadius: radius.lg,
      backgroundColor: color.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    eyebrow: {
      marginTop: 24,
      fontFamily: font.bold,
      fontSize: 11,
      letterSpacing: 2,
      color: color.accentDeep,
    },
    title: {
      marginTop: 4,
      fontFamily: font.extrabold,
      fontSize: 30,
      lineHeight: 38,
      letterSpacing: -0.5,
    },
    card: { marginTop: 36, padding: 20, gap: 14 },
    input: {
      height: 52,
      paddingHorizontal: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.background,
      fontFamily: font.regular,
      fontSize: 16,
      color: color.foreground,
    },
    signup: { marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
    footer: { marginTop: 'auto', paddingTop: 32, textAlign: 'center', color: color.muted },
  });
}
