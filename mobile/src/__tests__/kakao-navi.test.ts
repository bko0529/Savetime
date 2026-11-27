/**
 * 길 안내 순서 (COR-003): 앱 안 카카오내비 → 안 되면 카카오맵 앱 → 웹.
 * 카카오내비에 넘기는 사용자 구분 값은 기기 ID (개인정보 아님, SER-012)
 */
import { Linking } from 'react-native';
import { openRoute } from '../transport/links';

const mockReady = jest.fn(() => false);
const mockStart = jest.fn(async (...a: unknown[]) => void a);
jest.mock('../../modules/kakao-navi', () => ({
  kakaoNaviReady: () => mockReady(),
  startKakaoNavi: (...a: unknown[]) => mockStart(...a),
}));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'dev-123') }));
const mockLoc = jest.fn(
  async () => ({ lat: 36.815, lng: 127.1139 }) as { lat: number; lng: number } | null,
);
jest.mock('../transport/location', () => ({ currentLocation: () => mockLoc() }));

const goal = { lat: 36.8, lng: 127.12 };
let open: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

test('카카오내비가 되면 앱 안 길안내로 연다 (출발=내 위치, 사용자 값=기기 ID)', async () => {
  mockReady.mockReturnValue(true);
  await openRoute(goal, 'A병원');
  expect(mockStart).toHaveBeenCalledWith({
    goalName: 'A병원',
    goalLat: 36.8,
    goalLng: 127.12,
    startLat: 36.815,
    startLng: 127.1139,
    userKey: 'dev-123',
  });
  expect(open).not.toHaveBeenCalled();
});

test('카카오내비가 없으면(Expo Go) 카카오맵 앱 길찾기', async () => {
  mockReady.mockReturnValue(false);
  await openRoute(goal, 'A병원');
  expect(mockStart).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith('kakaomap://route?ep=36.8,127.12&by=CAR');
});

test('카카오내비가 실패하거나 내 위치를 모르면 카카오맵으로', async () => {
  mockReady.mockReturnValue(true);
  mockStart.mockRejectedValueOnce(new Error('C116'));
  await openRoute(goal, 'A병원');
  expect(open).toHaveBeenCalledWith('kakaomap://route?ep=36.8,127.12&by=CAR');

  open.mockClear();
  mockLoc.mockResolvedValueOnce(null);
  await openRoute(goal, 'A병원');
  expect(open).toHaveBeenCalledWith('kakaomap://route?ep=36.8,127.12&by=CAR');
});
