/**
 * S-02 로그인 (SFR-018, SER-011).
 * 아이디·비밀번호만 받는다. 근무 동안은 앱을 다시 열어도 로그인을 묻지 않는다.
 * 틀린 횟수·잠금은 서버가 판단하고 문구도 서버가 준다 → 앱은 그 문구를 그대로 보여 준다.
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/auth/AuthProvider';
import { checkLoginForm } from '../src/auth/loginForm';
import { color, radius } from '../src/ui/theme';

export default function LoginScreen() {
  const { state, login } = useAuth();
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
      <KeyboardAvoidingView style={s.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text style={s.eyebrow}>119 구급대원 전용</Text>
        <Text style={s.title}>세이브타임</Text>
        <Text style={s.sub}>병원 승인 후 출발하는 이송</Text>

        <View style={s.card}>
          {notice && !error ? <Text style={s.notice}>{notice}</Text> : null}
          <Text style={s.label}>아이디</Text>
          <TextInput
            style={s.input}
            value={loginId}
            onChangeText={setLoginId}
            placeholder="아이디"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="next"
            accessibilityLabel="아이디"
          />
          <Text style={s.label}>비밀번호</Text>
          <TextInput
            style={s.input}
            value={password}
            onChangeText={setPassword}
            placeholder="비밀번호"
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
            accessibilityLabel="비밀번호"
          />
          {error ? (
            <Text style={s.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Pressable
            style={({ pressed }) => [s.button, (pressed || busy) && s.buttonPressed]}
            onPress={submit}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="로그인"
          >
            {busy ? (
              <ActivityIndicator color={color.primaryText} />
            ) : (
              <Text style={s.buttonText}>로그인</Text>
            )}
          </Pressable>
          <Text style={s.hint}>근무 중에는 앱을 다시 열어도 로그인을 묻지 않아요</Text>
        </View>

        <Text style={s.footer}>
          비밀번호를 잊으면 소속 관리자에게 초기화를 요청하세요 · 5번 틀리면 10분 동안 잠겨요
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.background },
  wrap: { flex: 1, paddingHorizontal: 24, paddingTop: 48 },
  eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 2, color: color.accentDeep },
  title: { marginTop: 4, fontSize: 30, fontWeight: '800', color: color.foreground },
  sub: { marginTop: 6, fontSize: 14, color: color.muted },
  card: {
    marginTop: 32,
    padding: 20,
    borderRadius: radius.lg,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.border,
  },
  notice: {
    marginBottom: 12,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: color.warningSoft,
    color: color.warning,
    fontSize: 14,
  },
  label: {
    marginTop: 8,
    marginBottom: 6,
    fontSize: 13,
    fontWeight: '600',
    color: color.foreground,
  },
  input: {
    height: 52,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.background,
    fontSize: 16,
    color: color.foreground,
  },
  error: {
    marginTop: 12,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: color.accentSoft,
    color: color.accentDeep,
    fontSize: 14,
  },
  button: {
    marginTop: 16,
    height: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.primary,
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: color.primaryText, fontSize: 17, fontWeight: '700' },
  hint: { marginTop: 12, textAlign: 'center', fontSize: 12, color: color.muted },
  footer: {
    marginTop: 'auto',
    marginBottom: 16,
    textAlign: 'center',
    fontSize: 12,
    color: color.muted,
  },
});
