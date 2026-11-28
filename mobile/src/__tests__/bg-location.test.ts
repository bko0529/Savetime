/**
 * 이동 중 백그라운드 위치 (SFR-079 · COR-014): '앱 사용 중' 권한으로만, 화면 위 표시·안드로이드 상단 알림과 함께
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  handleTaskLocations,
  LOCATION_TASK,
  onBackgroundFixes,
  startBackgroundLocation,
  stopBackgroundLocation,
} from '../transport/bgLocation';

jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn(),
}));
jest.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { AutomotiveNavigation: 2 },
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestBackgroundPermissionsAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
  startLocationUpdatesAsync: jest.fn(async () => undefined),
  stopLocationUpdatesAsync: jest.fn(async () => undefined),
}));
const L = Location as jest.Mocked<typeof Location>;

const loc = (lat: number) => ({
  coords: {
    latitude: lat,
    longitude: 127.1,
    accuracy: 5,
    speed: 10,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
  },
  timestamp: 1_000,
});

beforeEach(() => jest.clearAllMocks());

test('앱이 켜질 때 OS 가 부를 위치 작업을 정의해 둔다', () => {
  // 모듈을 불러오는 순간 정의됨 (위 import)
  expect(TaskManager.defineTask).toBeDefined();
});

test('켤 때: 앱 사용 중 권한만 확인하고, 항상 허용은 묻지 않으며, 표시·상단 알림을 켠다', async () => {
  expect(await startBackgroundLocation()).toBe(true);
  expect(L.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
  const [task, opts] = L.startLocationUpdatesAsync.mock.calls[0]!;
  expect(task).toBe(LOCATION_TASK);
  expect(opts).toMatchObject({
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: { notificationTitle: '이송 중 · 위치 기록 중' },
  });
});

test('앱 사용 중 권한이 없으면 켜지 않는다', async () => {
  L.getForegroundPermissionsAsync.mockResolvedValueOnce({ granted: false } as never);
  expect(await startBackgroundLocation()).toBe(false);
  expect(L.startLocationUpdatesAsync).not.toHaveBeenCalled();
});

test('끝나면 멈춘다', async () => {
  L.hasStartedLocationUpdatesAsync.mockResolvedValueOnce(true);
  await stopBackgroundLocation();
  expect(L.stopLocationUpdatesAsync).toHaveBeenCalledWith(LOCATION_TASK);
});

test('OS 가 준 위치를 엔진에 넘기고, 엔진이 아직 없으면 기다렸다가 넘긴다', () => {
  onBackgroundFixes(null);
  handleTaskLocations({ locations: [loc(36.81), loc(36.82)] });
  const got: unknown[] = [];
  onBackgroundFixes((f) => got.push(...f));
  expect(got).toHaveLength(2);
  expect(got[0]).toMatchObject({ lat: 36.81, lng: 127.1, accuracyM: 5, speedKmh: 36, at: 1_000 });
  handleTaskLocations({ locations: [loc(36.83)] });
  expect(got).toHaveLength(3);
  onBackgroundFixes(null);
});
