/**
 * 모든 화면을 감싸는 틀.
 * - 글꼴(Pretendard)을 다 불러올 때까지 빈 화면
 * - AuthProvider: 로그인 상태 / QueryClientProvider: 서버 데이터 캐시 (다음 단계 화면부터 씀)
 * - Gate: 지금 상태(gateTarget)에 맞는 화면만 연다. 순서 규칙은 src/gate.ts 한 곳에만 있다
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { canSignup, gateTarget } from '../src/gate';
import { APP_VERSION, configStore, loadConfig } from '../src/state/config';
import { consentStore, loadConsent } from '../src/state/consent';
import { usePermissions } from '../src/state/permissions';
import { teamStore } from '../src/duty/team';
import { startTransportSync } from '../src/transport/engine';
import { loadPatient } from '../src/transport/patientStore';
import { TransportRouter } from '../src/transport/ui/TransportRouter';
import { useStore } from '../src/state/store';
import { color } from '../src/ui/theme';

function Splash() {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: color.background,
      }}
    >
      <ActivityIndicator color={color.accent} />
    </View>
  );
}

function Gate() {
  const { state } = useAuth();
  const { consent } = useStore(consentStore);
  const { minAppVersion } = useStore(configStore);
  const permissions = usePermissions();
  const t = useStore(teamStore);
  const duty = {
    team: t.team === 'loading' ? 'loading' : t.team ? 'joined' : 'none',
    started: t.started,
  } as const;

  // 서버 설정(최소 버전·기능 토글): 켜질 때와 1분마다 (SFR-142, QUR-013)
  useEffect(() => {
    void loadConsent();
    void loadPatient();
    void loadConfig();
    const t = setInterval(() => void loadConfig(), 60_000);
    return () => clearInterval(t);
  }, []);

  // 근무 중이면 팀의 이송 건을 서버와 맞춘다 (이벤트 받기 · 진행 중 이송 이어서 보기, SFR-133)
  const onDuty = state.status === 'signedIn' && duty.team === 'joined' && duty.started;
  useEffect(() => (onDuty ? startTransportSync() : undefined), [onDuty]);

  const input = { appVersion: APP_VERSION, minAppVersion, consent, permissions, auth: state, duty };
  const target = gateTarget(input);
  if (target === 'loading') return <Splash />;
  // Stack.Protected: guard 가 true 인 화면만 열린다. 지금 화면이 닫히면 열린 화면으로 자동 이동
  return (
    <>
      {target === 'home' ? <TransportRouter /> : null}
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }}
      >
        <Stack.Protected guard={target === 'update'}>
          <Stack.Screen name="update" />
        </Stack.Protected>
        <Stack.Protected guard={target === 'welcome'}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
        <Stack.Protected guard={target === 'permissions'}>
          <Stack.Screen name="permissions" />
        </Stack.Protected>
        <Stack.Protected guard={target === 'login'}>
          <Stack.Screen name="login" />
        </Stack.Protected>
        <Stack.Protected guard={target === 'pending'}>
          <Stack.Screen name="pending" />
        </Stack.Protected>
        <Stack.Protected guard={canSignup(input, target)}>
          <Stack.Screen name="signup" />
        </Stack.Protected>
        <Stack.Protected guard={target === 'duty'}>
          <Stack.Screen name="duty" />
          <Stack.Screen name="invite" />
          <Stack.Screen name="scan" options={{ presentation: 'modal' }} />
        </Stack.Protected>
        <Stack.Protected guard={target === 'home'}>
          <Stack.Screen name="index" />
          <Stack.Screen name="patient" />
          <Stack.Screen name="request" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());
  const [fontsLoaded] = useFonts({
    'Pretendard-Regular': require('../assets/fonts/Pretendard-Regular.otf'),
    'Pretendard-SemiBold': require('../assets/fonts/Pretendard-SemiBold.otf'),
    'Pretendard-Bold': require('../assets/fonts/Pretendard-Bold.otf'),
    'Pretendard-ExtraBold': require('../assets/fonts/Pretendard-ExtraBold.otf'),
  });
  if (!fontsLoaded) return <Splash />;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusBar style="dark" />
        <Gate />
      </AuthProvider>
    </QueryClientProvider>
  );
}
