import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import type { SignupForm } from '../auth/signupForm';

jest.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void m.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void m.delete(k)),
  };
});

// 실시간 연결은 이 테스트에서 실제로 붙지 않게
jest.mock('../realtime/socket', () => ({
  connectRealtime: jest.fn(),
  disconnectRealtime: jest.fn(),
  reconnectRealtime: jest.fn(),
  onEvent: jest.fn(() => () => undefined),
}));

type Call = { method: string; url: string };
const calls: Call[] = [];
const json = (status: number, body: unknown) => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
});
let routes: Record<string, () => unknown> = {};
beforeEach(() => {
  calls.length = 0;
  global.fetch = jest.fn(async (url: string, init: { method: string }) => {
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method: init.method, url: path });
    const h = routes[`${init.method} ${path}`];
    return h ? h() : json(404, { error: { code: 'NOT_FOUND', message: '없음' } });
  }) as unknown as typeof fetch;
});

let auth: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return (
    <Text>
      {auth.state.status === 'signedIn'
        ? `${auth.state.me.status}:${auth.state.me.name}`
        : auth.state.status}
    </Text>
  );
}
const form: SignupForm = {
  agencyCode: 'APP-TEST',
  safetyCenter: '센터',
  name: '앱테스트',
  rank: '소방교',
  employeeNo: '1',
  loginId: 'apptest1',
  password: 'abcd1234',
  password2: 'abcd1234',
  photo: { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' },
  photoConsent: true,
};
const tokens = { accessToken: 'a', refreshToken: 'r' };

test('처음 가입: POST /auth/signup 다음 같은 아이디로 로그인 → 승인 대기', async () => {
  routes = {
    'POST /auth/signup': () => json(201, { status: 'pending', appliedAt: '2026-11-26T03:00:00Z' }),
    'POST /auth/login': () =>
      json(200, { tokens, me: { id: 1, status: 'pending', name: '앱테스트' } }),
  };
  await render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByText('signedOut')).toBeTruthy());
  let r: string | null = 'x';
  await act(async () => {
    r = await auth.signup(form);
  });
  expect(r).toBeNull();
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'POST /auth/signup',
    'POST /auth/login',
  ]);
  expect(screen.getByText('pending:앱테스트')).toBeTruthy();
});

test('반려 후 다시 신청: PUT /me/signup 응답이 짧아도 GET /me 로 내 정보를 다시 받는다', async () => {
  routes = {
    'POST /auth/login': () =>
      json(200, { tokens, me: { id: 1, status: 'rejected', name: '앱테스트' } }),
    'PUT /me/signup': () => json(200, { status: 'pending', appliedAt: '2026-11-26T03:02:00Z' }),
    'GET /me': () => json(200, { id: 1, status: 'pending', name: '앱테스트' }),
  };
  await render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByText('signedOut')).toBeTruthy());
  await act(async () => void (await auth.login('apptest1', 'abcd1234')));
  expect(screen.getByText('rejected:앱테스트')).toBeTruthy();
  await act(async () => void (await auth.signup(form)));
  expect(calls.slice(-2).map((c) => `${c.method} ${c.url}`)).toEqual(['PUT /me/signup', 'GET /me']);
  expect(screen.getByText('pending:앱테스트')).toBeTruthy();
});

test('서버 오류 문구를 그대로 돌려준다 (없는 소방서 코드)', async () => {
  routes = {
    'POST /auth/signup': () =>
      json(404, { error: { code: 'AGENCY_NOT_FOUND', message: '소속기관 코드를 찾을 수 없어요' } }),
  };
  await render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByText('signedOut')).toBeTruthy());
  let r: string | null = null;
  await act(async () => {
    r = await auth.signup(form);
  });
  expect(r).toBe('소속기관 코드를 찾을 수 없어요');
});
