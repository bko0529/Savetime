/**
 * 모든 화면을 감싸는 틀.
 * - AuthProvider: 로그인 상태
 * - QueryClientProvider: 서버 데이터 캐시(TanStack Query). 다음 화면들(이송 요청 등)부터 쓴다
 * - 로그인 상태에 따라 화면을 고른다: 확인 중 → 빈 화면, 로그아웃 → /login, 로그인 → /
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { color } from '../src/ui/theme';

function Gate() {
  const { state } = useAuth();
  const segments = useSegments();
  const onLogin = segments[0] === 'login';

  if (state.status === 'loading') {
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
  if (state.status === 'signedOut' && !onLogin) return <Redirect href="/login" />;
  if (state.status === 'signedIn' && onLogin) return <Redirect href="/" />;
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }}
    />
  );
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusBar style="dark" />
        <Gate />
      </AuthProvider>
    </QueryClientProvider>
  );
}
