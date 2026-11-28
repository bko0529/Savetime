/**
 * 길 안내 페이지 (SFR-031 · COR-003 · D-137): 앱 안에 카카오내비를 내장. 다른 앱으로 넘어가지 않는다.
 * 카카오내비에 넘기는 사용자 구분 값은 기기 ID (개인정보 아님, SER-012)
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import NaviScreen from '../../app/navi';
import { __resetEngineForTest, apply, type ServerTransport } from '../transport/engine';

const mockReady = jest.fn(() => true);
jest.mock('../../modules/kakao-navi', () => {
  const { View: V } = jest.requireActual('react-native');
  return {
    kakaoNaviReady: () => mockReady(),
    KakaoNaviView: (p: object) => <V {...p} />,
    naviErrorText: (e: { code: string }) => `오류 ${e.code}`,
  };
});
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'dev-123') }));
const mockLoc = jest.fn(
  async () => ({ lat: 36.815, lng: 127.1139 }) as { lat: number; lng: number } | null,
);
jest.mock('../transport/location', () => ({
  ...jest.requireActual('../transport/location'),
  currentLocation: () => mockLoc(),
}));
const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: jest.fn() }) }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const moving = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
  id: 't-1',
  status: 'moving',
  version: 3,
  serverNow: '',
  requestRadiusKm: 20,
  fallbackRadiusKm: 20,
  fallbackReason: null,
  currentRound: null,
  requests: [],
  phoneTarget: null,
  confirmedHospital: {
    id: 101,
    name: '순천향대 천안병원',
    erPhone: '041-570-2119',
    memo: null,
    extraMemo: null,
    entrance: { lat: 36.8, lng: 127.13 },
    requestStatus: 'confirmed',
    closeReason: null,
  },
  canReRequest: false,
  destinationChangeUsed: false,
  navDeviceId: null,
  etaMin: 7,
  lastSentAssessmentSeq: 0,
  excludedHospitalIds: [],
  requestedGrade: null,
  ...patch,
});

const msg = <T,>(nativeEvent: T) => ({ nativeEvent });
let openUrl: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  mockReady.mockReturnValue(true);
  mockLoc.mockReset();
  mockLoc.mockResolvedValue({ lat: 36.815, lng: 127.1139 });
  openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  apply(moving(), 'ios-me');
});

test('확정 병원 입구로 앱 안 카카오내비를 띄운다 (출발=내 위치, 사용자 값=기기 ID)', async () => {
  await render(<NaviScreen />);
  const navi = await screen.findByTestId('kakao-navi');
  expect(navi.props.trip).toEqual({
    goalName: '순천향대 천안병원 응급실',
    goalLat: 36.8,
    goalLng: 127.13,
    startLat: 36.815,
    startLng: 127.1139,
    userKey: 'dev-123',
  });
  expect(screen.getByText('카카오내비 경로를 받는 중…')).toBeTruthy();
  await act(async () => navi.props.onReady());
  expect(screen.queryByText('카카오내비 경로를 받는 중…')).toBeNull();
  expect(screen.getByText('약 7분 남음 · 병원에 1분마다 전달')).toBeTruthy();
  expect(openUrl).not.toHaveBeenCalled();
  // 아래 띠의 '이송 화면으로'
  await fireEvent.press(screen.getByRole('button', { name: '이송 화면으로' }));
  expect(mockBack).toHaveBeenCalled();
});

test('시작하지 못하면 이유와 다시 시도 — 다른 앱으로 넘기지 않는다 (D-137)', async () => {
  await render(<NaviScreen />);
  const navi = await screen.findByTestId('kakao-navi');
  await act(async () => navi.props.onError(msg({ stage: 'init', code: 'C103', message: '' })));
  expect(screen.getByText('길 안내를 시작하지 못했어요')).toBeTruthy();
  expect(screen.getByText('오류 C103')).toBeTruthy();
  expect(openUrl).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }));
  expect(await screen.findByTestId('kakao-navi')).toBeTruthy();
});

test('내비가 도착을 알리면 도착 처리 버튼이 켜진다', async () => {
  await render(<NaviScreen />);
  expect(
    screen.getByRole('button', { name: '도착 처리 (입구 근처에서 켜져요)' }).props
      .accessibilityState,
  ).toMatchObject({ disabled: true });
  const navi = await screen.findByTestId('kakao-navi');
  await act(async () => navi.props.onEnded(msg({ reason: 'arrived' })));
  expect(screen.getByText('목적지에 도착했어요')).toBeTruthy();
  expect(screen.getByRole('button', { name: '도착 처리' })).toBeTruthy();
});

test('카카오내비가 없는 빌드(Expo Go)·내 위치 모름이면 이유를 보여 준다', async () => {
  mockReady.mockReturnValue(false);
  const r = await render(<NaviScreen />);
  expect(await screen.findByText(/이 앱 빌드에는 카카오내비가 없어요/)).toBeTruthy();
  r.unmount();

  mockReady.mockReturnValue(true);
  mockLoc.mockResolvedValueOnce(null);
  await render(<NaviScreen />);
  expect(await screen.findByText(/내 위치를 찾지 못했어요/)).toBeTruthy();
});
