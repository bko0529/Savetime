/**
 * 모든 화면을 감싸는 틀.
 * - 글꼴(Pretendard)을 다 불러올 때까지 빈 화면
 * - AuthProvider: 로그인 상태 / QueryClientProvider: 서버 데이터 캐시 (다음 단계 화면부터 씀)
 * - Gate: 지금 상태(gateTarget)에 맞는 화면만 연다. 순서 규칙은 src/gate.ts 한 곳에만 있다
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, useColorScheme, View } from 'react-native';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { canSignup, gateTarget } from '../src/gate';
import { APP_VERSION, configStore, loadConfig } from '../src/state/config';
import { consentStore, loadConsent } from '../src/state/consent';
import { usePermissions } from '../src/state/permissions';
import { teamStore } from '../src/duty/team';
import { setRouteOpener, setTransportNotifier, startTransportSync } from '../src/transport/engine';
import { notifyTeam } from '../src/transport/notify';
import { startDraftSync } from '../src/transport/teamDraft';
import { InvitePush } from '../src/duty/InvitePush';
import { NetBanner } from '../src/offline/NetBanner';
import { useNet } from '../src/offline/net';
import { loadPatient } from '../src/transport/patientStore';
import { TransportAlerts } from '../src/transport/ui/TransportAlerts';
import { TransportRouter } from '../src/transport/ui/TransportRouter';
import { useStore } from '../src/state/store';
import { Txt } from '../src/ui/kit';
import { applyScheme, color } from '../src/ui/theme';
import { effectiveScheme, loadThemePref, useThemePref } from '../src/ui/themePref';

// 이송 알림(SFR-130): 진동 + 소리 + 알림 배너
setTransportNotifier((kind, title, body) => void notifyTeam(kind, title, body));
// 경로 안내 담당 폰은 병원이 정해지면 길 안내를 저절로 연다 (SFR-132, 앱 안 내비 SDK 는 9단계)
// 운전 폰(경로 안내 담당)은 확정되면 앱 안 길 안내 페이지를 연다 (SFR-157). 이미 열려 있으면 그대로
setRouteOpener(() => router.navigate('/navi'));

function Splash() {
  const { online } = useNet();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        backgroundColor: color.background,
      }}
    >
      <ActivityIndicator color={color.accent} />
      {/* 앱을 열 때 서버에 닿지 못하면: 로그인은 그대로 두고 다시 시도 중임을 알린다 */}
      {!online ? (
        <Txt style={{ fontSize: 15, color: color.muted, textAlign: 'center' }}>
          서버에 연결하는 중이에요 · 로그인은 그대로예요
        </Txt>
      ) : null}
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
  useEffect(() => {
    if (!onDuty) return;
    const stopTransport = startTransportSync();
    // 팀원 간 환자 정보 공동 입력 (SFR-114)
    const stopDraft = startDraftSync();
    return () => {
      stopTransport();
      stopDraft();
    };
  }, [onDuty]);

  const input = { appVersion: APP_VERSION, minAppVersion, consent, permissions, auth: state, duty };
  const target = gateTarget(input);
  if (target === 'loading') return <Splash />;
  // Stack.Protected: guard 가 true 인 화면만 열린다. 지금 화면이 닫히면 열린 화면으로 자동 이동
  return (
    <>
      {target === 'home' ? <TransportRouter /> : null}
      {target === 'home' ? <TransportAlerts /> : null}
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
          <Stack.Screen name="call/[hospitalId]" />
          <Stack.Screen name="transport" />
          <Stack.Screen name="navi" options={{ gestureEnabled: false }} />
          <Stack.Screen name="log" />
          <Stack.Screen name="settings" />
        </Stack.Protected>
        {/* 비밀번호 바꾸기: 임시 비밀번호면 이 화면만, 근무 중에는 설정에서 (SFR-021) */}
        <Stack.Protected guard={target === 'password' || target === 'home'}>
          <Stack.Screen name="password" />
        </Stack.Protected>
      </Stack>
      {target === 'duty' || target === 'home' ? <InvitePush canOpen={target === 'duty'} /> : null}
      <NetBanner />
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
  // 화면 테마 (QUR-005): 휴대폰 설정을 따르거나 설정에서 고른 값. 바뀌면 색을 바꾸고 화면을 다시 그린다
  const system = useColorScheme();
  const pref = useThemePref();
  const scheme = effectiveScheme(pref, system);
  applyScheme(scheme); // 그리기 전에 색을 맞춘다 (같은 값이면 아무 일 안 함)
  useEffect(() => {
    void loadThemePref();
  }, []);
  if (!fontsLoaded) return <Splash />;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        {/* key 가 바뀌면 화면을 새 색으로 다시 그린다 (로그인 상태는 그대로) */}
        <Gate key={scheme} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
