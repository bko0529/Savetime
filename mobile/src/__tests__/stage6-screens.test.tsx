import { fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import CallScreen from '../../app/call/[hospitalId]';
import TransportScreen from '../../app/transport';
import { __resetEngineForTest, actions, apply, type ServerTransport } from '../transport/engine';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  api: jest.fn(async () => ({})),
}));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'ios-me') }));
jest.mock('../transport/location', () => ({
  ...jest.requireActual('../transport/location'),
  currentLocation: jest.fn(async () => null),
}));
const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => ({ hospitalId: '101' }),
}));

const T = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
  id: 't-1',
  status: 'phone_check',
  version: 2,
  serverNow: '',
  requestRadiusKm: 20,
  fallbackRadiusKm: 30,
  fallbackReason: null,
  currentRound: { roundNo: 1, sentAt: new Date().toISOString(), respondUntil: '' },
  requests: [],
  phoneTarget: { hospitalId: 101, name: '순천향대 천안병원', erPhone: '041-570-2119' },
  confirmedHospital: null,
  canReRequest: false,
  destinationChangeUsed: false,
  navDeviceId: null,
  etaMin: null,
  lastSentAssessmentSeq: 0,
  excludedHospitalIds: [],
  requestedGrade: null,
  ...patch,
});
const moving = (patch: Partial<ServerTransport> = {}) =>
  T({
    status: 'moving',
    phoneTarget: null,
    etaMin: 7,
    confirmedHospital: {
      id: 101,
      name: '순천향대 천안병원',
      erPhone: '041-570-2119',
      memo: '정문 오른쪽',
      extraMemo: null,
      entrance: { lat: 36.8, lng: 127.13 },
      requestStatus: 'confirmed',
      closeReason: null,
    },
    ...patch,
  });

beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

test('전화 확인: 응급실 직통으로 전화를 건다 (숫자만)', async () => {
  apply(T(), 'ios-me');
  await render(<CallScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '순천향대 천안병원 응급실에 전화' }));
  expect(Linking.openURL).toHaveBeenCalledWith('tel:0415702119');
});

test('전화 확인: 수용 확정 · 연결 실패 사유 · 거절', async () => {
  apply(T(), 'ios-me');
  const ok = { ok: true as const, value: undefined };
  const accepted = jest.spyOn(actions, 'phoneAccepted').mockResolvedValue(ok);
  const proceed = jest.spyOn(actions, 'phoneProceed').mockResolvedValue(ok);
  const rejected = jest
    .spyOn(actions, 'phoneRejected')
    .mockResolvedValue({ ok: true, value: null });
  await render(<CallScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '수용 확정 → 출발' }));
  expect(accepted).toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: '확인 생략' }));
  await fireEvent.press(screen.getByRole('button', { name: '환자가 급함' }));
  expect(proceed).toHaveBeenCalledWith('urgent', 'skipped');
  await fireEvent.press(screen.getByRole('button', { name: '거절 → 다음 병원' }));
  // 거절 사유를 고른다 (SFR-044). 기타면 글도 같이
  await fireEvent.changeText(screen.getByLabelText('기타 거절 사유'), '구급차 진입 불가');
  await fireEvent.press(screen.getByRole('button', { name: '거절 사유 기타' }));
  expect(rejected).toHaveBeenCalledWith('etc', '구급차 진입 불가');
});

test('전화 확인에서 돌아가면 결과 없이 닫는다 (dismissed)', async () => {
  apply(T(), 'ios-me');
  const dismiss = jest
    .spyOn(actions, 'phoneDismiss')
    .mockResolvedValue({ ok: true, value: undefined });
  await render(<CallScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '← 요청 화면으로' }));
  expect(dismiss).toHaveBeenCalled();
});

test('이동 중: 남은 시간 · 병원 안내 · 길 안내 열기', async () => {
  apply(moving(), 'ios-me');
  await render(<TransportScreen />);
  expect(screen.getByText('순천향대 천안병원 · 7분 남음')).toBeTruthy();
  expect(screen.getByText('약 7분')).toBeTruthy();
  expect(screen.getByText('병원 안내 · "정문 오른쪽"')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '길 안내 열기 (카카오내비)' }));
  // 다른 앱(카카오맵)이 아니라 앱 안 길 안내 페이지로 (D-137)
  expect(mockPush).toHaveBeenCalledWith('/navi');
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('이동 중: 입구 근처가 아니면 도착 처리가 꺼져 있고, 누르면 켜진다', async () => {
  apply(moving(), 'ios-me');
  const arrive = jest.spyOn(actions, 'arrive').mockResolvedValue({ ok: true, value: undefined });
  await render(<TransportScreen />);
  expect(screen.queryByRole('button', { name: '도착 처리' })).toBeNull();
  await fireEvent.press(
    screen.getByRole('button', { name: '도착했어요 (입구 근처에서는 저절로 켜져요)' }),
  );
  await fireEvent.press(screen.getByRole('button', { name: '도착 처리' }));
  expect(arrive).toHaveBeenCalledWith('button');
});

test('이동 중: 승인 취소 경보 → 다시 요청 (자동으로 하지 않음)', async () => {
  apply(moving({ canReRequest: true }), 'ios-me');
  const re = jest.spyOn(actions, 'reRequest').mockResolvedValue({ ok: true, value: undefined });
  await render(<TransportScreen />);
  expect(screen.getByText('순천향대 천안병원이(가) 승인을 취소했어요')).toBeTruthy();
  expect(re).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: '다시 요청 (현재 반경 20km)' }));
  expect(re).toHaveBeenCalled();
});

test('이동 중: 목적지 변경은 길게 눌러 사유를 고른다, 한 번 쓰면 꺼진다', async () => {
  apply(moving(), 'ios-me');
  const change = jest
    .spyOn(actions, 'changeDestination')
    .mockResolvedValue({ ok: true, value: undefined });
  await render(<TransportScreen />);
  await fireEvent(screen.getByRole('button', { name: '목적지 변경' }), 'longPress');
  await fireEvent.press(screen.getByRole('button', { name: '도로 사정' }));
  expect(change).toHaveBeenCalledWith('road');

  apply(moving({ destinationChangeUsed: true }), 'ios-me');
  await render(<TransportScreen />);
  expect(screen.getByText('목적지 변경 (사용함)')).toBeTruthy();
});

test('이동 중: 이송 취소는 한 번 더 묻는다', async () => {
  apply(moving(), 'ios-me');
  const alert = jest.spyOn(Alert, 'alert');
  await render(<TransportScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '이송 취소' }));
  expect(alert.mock.calls[0]![0]).toBe('이송을 취소할까요?');
});

test('길 안내 열기는 다른 앱이 아니라 앱 안 길 안내 페이지로 (D-137)', async () => {
  apply(moving(), 'ios-me');
  await render(<TransportScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '길 안내 열기 (카카오내비)' }));
  expect(mockPush).toHaveBeenCalledWith('/navi');
});
