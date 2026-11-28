import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PatientScreen from '../../app/patient';
import RequestScreen from '../../app/request';
import { api } from '../api/client';
import { dispatch } from '../realtime/socket';
import {
  __resetEngineForTest,
  __setLoadedForTest,
  actions,
  apply,
  getEngine,
  loadNearby,
  setTransportNotifier,
  startTransportSync,
  type ServerTransport,
} from '../transport/engine';
import { bedsLabel } from '../transport/hospitals';
import { isOutlier, manualLocation, nearEntrance, setManualLocation } from '../transport/location';
import { emptyPatient, missingMessage, REQUIRED_FIELDS, UNKNOWN } from '../transport/patient';
import { patientStore } from '../transport/patientStore';
import { TransportRouter } from '../transport/ui/TransportRouter';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), api: jest.fn() }));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'ios-me') }));
const mockFix = jest.fn();
jest.mock('../transport/location', () => {
  const actual = jest.requireActual('../transport/location');
  return {
    ...actual,
    currentFix: (...a: unknown[]) => mockFix(...a),
    currentLocation: async () => {
      const f = await mockFix();
      return f ? { lat: f.lat, lng: f.lng } : (actual.manualLocation()?.at ?? null);
    },
  };
});
let mockPath = '/';
const mockRouter = {
  back: jest.fn(),
  replace: jest.fn(),
  navigate: jest.fn(),
  push: jest.fn(),
  dismissTo: jest.fn(),
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, usePathname: () => mockPath }));
const mockApi = jest.mocked(api);

const T = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
  id: 't-1',
  status: 'fallback',
  version: 1,
  serverNow: '',
  requestRadiusKm: 20,
  fallbackRadiusKm: 20,
  fallbackReason: 'all_rejected',
  currentRound: null,
  requests: [],
  phoneTarget: null,
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
const card = (id: number, patch: Record<string, unknown> = {}) => ({
  id,
  name: `병원${id}`,
  lat: 0,
  lng: 0,
  distanceKm: id,
  etaMin: 5,
  beds: { er: '2/8', icu: null, or: null },
  bedsSourceTime: null,
  capabilityCount: { available: 1, total: 3 },
  erPhone: '041',
  grade: 2,
  collectedAt: '2026-11-27T05:00:00Z',
  stale: false,
  ...patch,
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  patientStore.reset();
  setManualLocation(null);
  mockFix.mockResolvedValue({ lat: 36.8, lng: 127.1, accuracyM: 5, speedKmh: 0, at: Date.now() });
  mockPath = '/';
});

describe('첫 화면 · 앱 재실행 복구 (SFR-107 · 133, D-138)', () => {
  test('진행 중 이송이 없으면 홈이 첫 화면 (D-138, 러버블과 같게)', async () => {
    await render(<TransportRouter />);
    expect(mockRouter.navigate).not.toHaveBeenCalled(); // 서버를 읽기 전에는 기다림
    await act(async () => __setLoadedForTest());
    expect(mockRouter.navigate).not.toHaveBeenCalled(); // 홈 그대로
  });
  test('진행 중 이송이 있으면 그 상태 화면으로 바로', async () => {
    apply(T({ status: 'moving' }), 'ios-me');
    await render(<TransportRouter />);
    await act(async () => __setLoadedForTest());
    expect(mockRouter.navigate).toHaveBeenCalledWith('/transport');
  });
});

describe('환자 정보 입력', () => {
  test("빈 필수 칸을 이름으로 안내 ('맥박을 입력하세요', 받침에 맞게)", () => {
    const p = { ...emptyPatient };
    REQUIRED_FIELDS.forEach((k) => ((p[k] as string) = '1'));
    p.pulse = '';
    expect(missingMessage(p)).toBe('맥박을 입력하세요');
    p.pulse = '1';
    p.resp = '';
    expect(missingMessage(p)).toBe('호흡수를 입력하세요');
    p.resp = '1';
    expect(missingMessage(p)).toBeNull();
  });

  test('반경을 골라 요청한다 (SFR-012)', async () => {
    mockApi.mockResolvedValue({ count: 7 });
    const full = { ...emptyPatient };
    REQUIRED_FIELDS.forEach((k) => ((full[k] as string) = UNKNOWN));
    patientStore.set({ patient: full });
    const create = jest.spyOn(actions, 'create').mockResolvedValue({ ok: true, value: undefined });
    await render(<PatientScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: '반경 30km' }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('GET', expect.stringContaining('radiusKm=30')),
    );
    expect(await screen.findByText('7곳')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '병원에 요청' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![2]).toBe(30);
  });

  test('위치를 못 잡으면 주소로 기준 위치를 정한다 (SFR-009)', async () => {
    mockFix.mockResolvedValue(null);
    mockApi.mockImplementation(async (_m: string, path: string) =>
      path.startsWith('/geocode')
        ? [{ address: '충남 천안시 동남구 신부동', location: { lat: 36.81, lng: 127.15 } }]
        : { count: 3 },
    );
    await render(<PatientScreen />);
    await fireEvent.press(
      await screen.findByRole('button', { name: '위치 확인 불가 · 주소 입력' }),
    );
    await fireEvent.changeText(screen.getByLabelText('주소 검색'), '신부동');
    await fireEvent.press(screen.getByRole('button', { name: '주소 찾기' }));
    await fireEvent.press(
      await screen.findByRole('button', { name: '충남 천안시 동남구 신부동 고르기' }),
    );
    expect(manualLocation()).toEqual({
      at: { lat: 36.81, lng: 127.15 },
      label: '충남 천안시 동남구 신부동',
    });
    expect(await screen.findByText('기준 위치: 충남 천안시 동남구 신부동 · 바꾸기')).toBeTruthy();
  });
});

describe('추천 목록 (SFR-027 · 029 · 006 · 081)', () => {
  test('상위 5곳 카드 + 병상 정보 없는 병원 + 기준 시각 문구', async () => {
    apply(T(), 'ios-me');
    mockApi.mockResolvedValue({
      radiusKm: 20,
      items: [1, 2, 3, 4, 5].map((i) => card(i, i === 2 ? { stale: true } : {})),
      map: [1, 2, 3, 4, 5, 6, 7].map((i) => card(i)),
      noBedInfo: [
        card(9, { beds: { er: null, icu: null, or: null }, collectedAt: null, stale: null }),
      ],
      emptyGuide: null,
    });
    await act(async () => loadNearby());
    await render(<RequestScreen />);
    expect(screen.getAllByText(/^병원[1-5]$/)).toHaveLength(5);
    expect(screen.queryByText('병원6')).toBeNull(); // 반경 안 전체는 지도용 (카드 아님)
    expect(screen.getByText('병원9')).toBeTruthy();
    expect(screen.getByText('병상 정보 없음 · 전화로 확인')).toBeTruthy();
    expect(screen.getAllByText(/참고용 정보 · 기준/)).toHaveLength(1);
    expect(getEngine().mapIds).toHaveLength(7);
  });

  test('추천 0건이면 한 단계 넓혀 찾기 (요청은 안 보냄), 새로고침', async () => {
    apply(T(), 'ios-me');
    mockApi.mockResolvedValue({
      radiusKm: 20,
      items: [],
      map: [],
      noBedInfo: [],
      emptyGuide: 'expand_radius',
    });
    await act(async () => loadNearby());
    await render(<RequestScreen />);
    expect(screen.getByText('반경을 30km로 넓혀 다시 찾을까요?')).toBeTruthy();
    mockApi.mockClear();
    mockApi.mockResolvedValue(T());
    await fireEvent.press(screen.getByRole('button', { name: '넓혀서 찾기' }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('PUT', '/transports/t-1/fallback-radius', {
        body: { radiusKm: 30 },
      }),
    );
    mockApi.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('GET', '/transports/t-1/recommendations', {
        timeoutMs: 5000,
      }),
    );
  });

  test('40km 면 넓히기 없이 전화로 확인 안내', async () => {
    apply(T({ fallbackRadiusKm: 40 }), 'ios-me');
    mockApi.mockResolvedValue({
      radiusKm: 40,
      items: [],
      map: [],
      noBedInfo: [],
      emptyGuide: 'call_nearby',
    });
    await act(async () => loadNearby());
    await render(<RequestScreen />);
    expect(screen.getByText('추천할 병원이 없어요 · 가까운 병원에 전화로 확인하세요')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '넓혀서 찾기' })).toBeNull();
  });

  test('데이터 상태 문구 (SFR-081)', () => {
    const at = '2026-11-27T05:00:00Z';
    const t = new Date(at);
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    expect(bedsLabel({ collectedAt: at, stale: false, bedsAt: '' })).toBe(`기준 ${hm}`);
    expect(bedsLabel({ collectedAt: at, stale: true, bedsAt: '' })).toBe(
      `참고용 정보 · 기준 ${hm}`,
    );
    expect(bedsLabel({ collectedAt: at, stale: false, bedsAt: '' }, true)).toBe(
      `참고용 정보 · 기준 ${hm}`,
    );
  });
});

describe('도착 판정 (SFR-038 · 040)', () => {
  test('입구까지 거리 − 오차 ≤ 30m 이고 시속 10km 이하일 때만', () => {
    expect(nearEntrance(25, 10, 5)).toBe(true);
    expect(nearEntrance(45, 10, 5)).toBe(false);
    expect(nearEntrance(25, 10, 30)).toBe(false);
    expect(nearEntrance(25, 10, null)).toBe(false);
  });
  test('초속 60m 를 넘는 이동은 이상치', () => {
    const a = { lat: 36.8, lng: 127.1, accuracyM: 5, speedKmh: 40, at: 0 };
    const far = { ...a, lat: 36.8072, at: 1000 }; // 1초에 약 800m
    const ok = { ...a, lat: 36.8001, at: 1000 }; // 1초에 약 11m
    expect(isOutlier(a, far)).toBe(true);
    expect(isOutlier(a, ok)).toBe(false);
    expect(isOutlier(null, far)).toBe(false);
  });
});

describe('대원 알림 (SFR-130)', () => {
  test('첫 승인 · 예비 추천 · 승인 해제 1분 전 · 승인 취소 때 알린다', async () => {
    mockApi.mockRejectedValue(new Error('x'));
    const calls: string[] = [];
    setTransportNotifier((kind, title) => calls.push(`${kind}:${title}`));
    const stop = startTransportSync();
    let seq = 5000;
    const ev = (data: Record<string, unknown>) => ({
      seq: ++seq,
      room: 'team:1',
      occurredAt: '',
      serverNow: new Date().toISOString(),
      data,
    });
    dispatch(
      'request.approved',
      ev({
        transportId: 't',
        firstApproval: true,
        afterReconnect: false,
        request: { hospitalName: 'B병원', etaMin: 9 },
      }),
    );
    dispatch(
      'request.approved',
      ev({
        transportId: 't',
        firstApproval: false,
        afterReconnect: false,
        request: { hospitalName: 'C병원' },
      }),
    );
    dispatch('transport.status', ev({ transportId: 't', status: 'fallback' }));
    dispatch('approval.expiring', ev({ transportId: 't', releaseAt: '' }));
    dispatch(
      'request.cancelled',
      ev({ transportId: 't', hospitalName: 'B병원', reason: '병상 부족', wasConfirmed: true }),
    );
    stop();
    setTransportNotifier(() => {});
    expect(calls).toEqual([
      'approval:B병원 승인',
      'warning:승인한 병원이 없어요',
      'warning:1분 뒤 승인이 해제돼요',
      'danger:B병원 승인 취소',
    ]);
  });
});
