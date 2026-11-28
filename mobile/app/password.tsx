/**
 * 비밀번호 바꾸기 (SFR-021, 닫은 PR #108 그대로).
 * - 관리자가 초기화한 임시 비밀번호로 들어오면 이 화면만 볼 수 있다 (화면 순서 gate). 바꾸면 원래 흐름(근무 시작)으로 넘어간다
 * - 설정에서 들어오면 평소처럼 바꾸고 설정으로 돌아간다
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useAuth } from '../src/auth/AuthProvider';
import { newPasswordError } from '../src/auth/passwordForm';
import { BigButton, Field, Label, Notice, PhoneScreen, Tile } from '../src/ui/kit';

export default function PasswordScreen() {
  const { state, changePassword, leave } = useAuth();
  const router = useRouter();
  const required = state.status === 'signedIn' && !!state.me.mustChangePassword;
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (busy) return;
    // 규칙은 먼저 화면에서 보고, 지금 비밀번호가 맞는지는 서버가 본다 (5번 틀리면 10분 잠금)
    const bad = newPasswordError(f);
    if (bad) return setErr(bad);
    setBusy(true);
    const fail = await changePassword(f.current, f.next);
    setBusy(false);
    if (fail) return setErr(fail);
    setErr('');
    setF({ current: '', next: '', confirm: '' });
    // 임시 비밀번호였으면 화면 순서(gate)가 다음 화면으로 보낸다. 설정에서 왔으면 완료 표시
    if (!required) setDone(true);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <PhoneScreen
        title={required ? '새 비밀번호를 정해 주세요' : '비밀번호 바꾸기'}
        subtitle={
          required
            ? '관리자가 초기화한 임시 비밀번호로 들어왔어요'
            : '8자 이상, 영문과 숫자를 섞어 주세요'
        }
        footer={
          required ? (
            <BigButton variant="outline" onPress={() => void leave('logout')}>
              로그아웃
            </BigButton>
          ) : (
            <BigButton variant="outline" onPress={() => router.back()}>
              ← 설정으로
            </BigButton>
          )
        }
      >
        {required ? (
          <View style={{ marginBottom: 16 }}>
            <Notice tone="warn">비밀번호를 바꾸기 전에는 다른 기능을 쓸 수 없어요</Notice>
          </View>
        ) : null}
        <Tile style={{ padding: 20, gap: 14 }}>
          <View>
            <Label>{required ? '임시 비밀번호' : '지금 비밀번호'}</Label>
            <Field
              value={f.current}
              onChangeText={set('current')}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              accessibilityLabel="지금 비밀번호"
            />
          </View>
          <View>
            <Label>새 비밀번호</Label>
            <Field
              value={f.next}
              onChangeText={set('next')}
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              placeholder="8자 이상 · 영문+숫자"
              accessibilityLabel="새 비밀번호"
            />
          </View>
          <View>
            <Label>새 비밀번호 확인</Label>
            <Field
              value={f.confirm}
              onChangeText={set('confirm')}
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              accessibilityLabel="새 비밀번호 확인"
            />
          </View>
          {err ? <Notice tone="warn">{err}</Notice> : null}
          {done ? <Notice tone="ok">비밀번호를 바꿨어요</Notice> : null}
          <BigButton size="lg" busy={busy} onPress={() => void submit()}>
            비밀번호 바꾸기
          </BigButton>
        </Tile>
      </PhoneScreen>
    </KeyboardAvoidingView>
  );
}
