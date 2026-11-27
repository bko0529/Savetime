import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PasswordScreen from '../../app/password';
import SettingsScreen from '../../app/settings';
import { newPasswordError } from '../auth/passwordForm';
import { teamStore } from '../duty/team';
import { gateTarget, type GateInput } from '../gate';
import { dispatch } from '../realtime/socket';
import {
  __resetEngineForTest,
  actions,
  apply,
  startTransportSync,
  type ServerTransport,
} from '../transport/engine';
import { alertStore, unacceptableText } from '../transport/hospitalAlerts';
import { api, setTokenHooks } from '../api/client';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), api: jest.fn() }));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'ios-me') }));
jest.mock('../transport/location', () => ({
  ...jest.requireActual('../transport/location'),
  currentLocation: jest.fn(async () => ({ lat: 1, lng: 2 })),
}));
jest.mock('../state/permissions', () => ({
  ...jest.requireActual('../state/permissions'),
  usePermissions: () => ({ location: 'granted', notify: 'denied', locationCanAsk: true }),
}));
const mockAuth = {
  state: {
    status: 'signedIn',
    me: {
      id: 1,
      status: 'approved',
      name: '김구조',
      rank: '소방교',
      agency: '천안동남소방서',
      safetyCenter: '신방센터',
      mustChangePassword: false,
    },
  } as { status: 'signedIn'; me: Record<string, unknown> },
  leave: jest.fn(async () => null),
  changePassword: jest.fn(async () => null as string | null),
};
jest.mock('../auth/AuthProvider', () => ({ useAuth: () => mockAuth }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), navigate: jest.fn() }),
}));
const mockApi = jest.mocked(api);

const T = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
  id: 't-1',
  status: 'moving',
  version: 1,
  serverNow: '',
  requestRadiusKm: 20,
  fallbackRadiusKm: 30,
  fallbackReason: null,
  currentRound: null,
  requests: [],
  phoneTarget: null,
  confirmedHospital: {
    id: 101,
    name: '순천향대 천안병원',
    erPhone: null,
    memo: '정문',
    extraMemo: '2번 출입구로 오세요',
    entrance: { lat: 0, lng: 0 },
    requestStatus: 'confirmed',
    closeReason: null,
  },
  canReRequest: false,
  destinationChangeUsed: false,
  navDeviceId: null,
  etaMin: 5,
  lastSentAssessmentSeq: 0,
  excludedHospitalIds: [],
  requestedGrade: null,
  ...patch,
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  teamStore.reset();
  alertStore.reset();
  mockAuth.state.me.mustChangePassword = false;
  // 이송 다시 읽기는 로그인 토큰이 있어야 한다
  setTokenHooks({
    get: () => ({ accessToken: 'a', refreshToken: 'r' }),
    set: () => {},
    lost: () => {},
  });
});

test('비밀번호 입력 검사 (SFR-021)', () => {
  expect(newPasswordError({ current: '', next: 'abcd1234', confirm: 'abcd1234' })).toBe(
    '지금 비밀번호를 넣어 주세요',
  );
  expect(newPasswordError({ current: 'old12345', next: 'abcdefgh', confirm: 'abcdefgh' })).toBe(
    '새 비밀번호는 8자 이상, 영문과 숫자를 섞어 주세요',
  );
  expect(newPasswordError({ current: 'abcd1234', next: 'abcd1234', confirm: 'abcd1234' })).toBe(
    '지금 비밀번호와 다른 비밀번호를 정해 주세요',
  );
  expect(newPasswordError({ current: 'old12345', next: 'abcd1234', confirm: 'abcd12345' })).toBe(
    '새 비밀번호 두 칸이 서로 달라요',
  );
  expect(
    newPasswordError({ current: 'old12345', next: 'abcd1234', confirm: 'abcd1234' }),
  ).toBeNull();
});

test('임시 비밀번호면 근무보다 먼저 비밀번호 화면만', () => {
  const g: GateInput = {
    appVersion: '1.0.0',
    minAppVersion: '1.0.0',
    consent: 'agreed',
    permissions: { location: 'granted', notify: 'granted' },
    auth: { status: 'signedIn', me: { id: 1, status: 'approved', mustChangePassword: true } },
    duty: { team: 'joined', started: true },
  };
  expect(gateTarget(g)).toBe('password');
});

test('비밀번호 화면: 임시 비밀번호면 안내·로그아웃, 바꾸기를 보낸다', async () => {
  mockAuth.state.me.mustChangePassword = true;
  await render(<PasswordScreen />);
  expect(screen.getByText('비밀번호를 바꾸기 전에는 다른 기능을 쓸 수 없어요')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('지금 비밀번호'), 'temp1234');
  await fireEvent.changeText(screen.getByLabelText('새 비밀번호'), 'newpass99');
  await fireEvent.changeText(screen.getByLabelText('새 비밀번호 확인'), 'newpass99');
  await fireEvent.press(screen.getByRole('button', { name: '비밀번호 바꾸기' }));
  await waitFor(() =>
    expect(mockAuth.changePassword).toHaveBeenCalledWith('temp1234', 'newpass99'),
  );
  await fireEvent.press(screen.getByRole('button', { name: '로그아웃' }));
  expect(mockAuth.leave).toHaveBeenCalledWith('logout');
});

test('설정: 진행 중 이송 + 팀에 나 혼자면 취소된다고 미리 알리고, 확인해야 근무 종료', async () => {
  teamStore.set({
    team: {
      id: 1,
      code: '4821',
      members: [{ paramedicId: 1, name: '김구조', role: 'driver', isMe: true }],
    },
    started: true,
    startedAt: new Date(2026, 10, 27, 8, 0).getTime(),
  });
  apply(T(), 'ios-me');
  await render(<SettingsScreen />);
  expect(screen.getByText('08:00 시작 · 22:00 자동 종료')).toBeTruthy();
  expect(screen.getByText('운전')).toBeTruthy();
  expect(screen.getByText('꺼짐')).toBeTruthy(); // 알림 거부
  await fireEvent.press(screen.getByRole('button', { name: '근무 종료' }));
  expect(screen.getByText('진행 중 이송 1건이 있어요')).toBeTruthy();
  expect(screen.getByText(/진행 중 이송을 '취소'\(사유: 근무 종료\)로 끝내요/)).toBeTruthy();
  expect(mockAuth.leave).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: '근무 종료 확인' }));
  await waitFor(() => expect(mockAuth.leave).toHaveBeenCalledWith('duty_end'));
});

test('설정: 회원 탈퇴는 되돌릴 수 없다고 알린다', async () => {
  teamStore.set({
    team: { id: 1, code: '4821', members: [{ paramedicId: 1, isMe: true, role: 'care' }] },
    started: true,
  });
  await render(<SettingsScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '회원 탈퇴' }));
  expect(screen.getByText('계정 · 프로필 정보가 바로 삭제되고 되돌릴 수 없어요.')).toBeTruthy();
});

test('추가 메모 이벤트 → 다시 읽고 배너에 메모 (SFR-140)', async () => {
  mockApi.mockResolvedValue(T());
  apply(T({ confirmedHospital: { ...T().confirmedHospital!, extraMemo: null } }), 'ios-me');
  const stop = startTransportSync();
  try {
    await act(async () => {
      dispatch('hospital.extra_memo', {
        seq: 9001,
        room: 'team:1',
        occurredAt: '',
        serverNow: new Date().toISOString(),
        data: { transportId: 't-1', hospitalRequestId: 1, hospitalName: '순천향대 천안병원' },
      });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(alertStore.get().memo).toMatchObject({
      hospitalName: '순천향대 천안병원',
      memo: '2번 출입구로 오세요',
    });
  } finally {
    stop();
  }
});

test('수용 불가 이벤트 → 경보, 다시 요청은 직전 이송 건을 이어받는다 (SFR-157·158)', async () => {
  mockApi.mockRejectedValue(new Error('x'));
  const stop = startTransportSync();
  dispatch('transport.unacceptable', {
    seq: 9002,
    room: 'team:1',
    occurredAt: '',
    serverNow: new Date().toISOString(),
    data: { transportId: 't-old', hospitalName: '단국대병원', reason: 'er_bed' },
  });
  expect(alertStore.get().unacceptable).toMatchObject({
    transportId: 't-old',
    hospitalName: '단국대병원',
  });
  expect(unacceptableText('er_bed')).toBe('응급실 병상 부족');
  stop();

  mockApi.mockReset();
  mockApi
    .mockResolvedValueOnce(T({ id: 't-new', status: 'requesting', confirmedHospital: null }))
    .mockResolvedValue({ map: [] });
  actions.reset();
  actions.continueFrom('t-old');
  await actions.create(null, {
    grade: null,
    complaint: 'x',
    sex: '',
    age: '',
    consciousness: '',
    bp: '',
    pulse: '',
    resp: '',
    spo2: '',
    painSite: '',
    painScore: '',
    onset: '',
    trauma: '',
    history: '',
    temp: '',
    glucose: '',
    ktas: '',
  });
  expect(
    (mockApi.mock.calls[0]![2] as { body: { prevTransportId?: string } }).body.prevTransportId,
  ).toBe('t-old');
  // 한 번 쓰면 다음 요청에는 붙지 않는다
  mockApi.mockResolvedValueOnce(T({ id: 't-3', status: 'requesting', confirmedHospital: null }));
  await actions.create(null, {
    grade: null,
    complaint: 'x',
    sex: '',
    age: '',
    consciousness: '',
    bp: '',
    pulse: '',
    resp: '',
    spo2: '',
    painSite: '',
    painScore: '',
    onset: '',
    trauma: '',
    history: '',
    temp: '',
    glucose: '',
    ktas: '',
  });
  const third = mockApi.mock.calls.find(
    (c) => c[1] === '/transports' && c !== mockApi.mock.calls[0],
  );
  expect(
    (third![2] as { body: { prevTransportId?: string } }).body.prevTransportId,
  ).toBeUndefined();
});
