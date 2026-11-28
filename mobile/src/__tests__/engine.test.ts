import { ApiError, api, setTokenHooks } from '../api/client';
import { teamStore } from '../duty/team';
import { dispatch } from '../realtime/socket';
import {
  __resetEngineForTest,
  actions,
  apply,
  getEngine,
  hospital,
  refresh,
  startTransportSync,
  type ServerTransport,
} from '../transport/engine';
import { emptyPatient, toAssessment, UNKNOWN } from '../transport/patient';

jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), api: jest.fn() }));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'ios-me') }));
jest.mock('../transport/location', () => ({
  ...jest.requireActual('../transport/location'),
  currentLocation: jest.fn(async () => ({ lat: 36.815, lng: 127.1139 })),
}));
// 백그라운드 위치 (SFR-079): OS 가 위치를 넘겨주는 것을 테스트가 흉내 낸다
let mockBgListener: ((fixes: unknown[]) => void) | null = null;
const mockBgStart = jest.fn(async () => true);
const mockBgStop = jest.fn(async () => undefined);
jest.mock('../transport/bgLocation', () => ({
  onBackgroundFixes: (fn: ((fixes: unknown[]) => void) | null) => {
    mockBgListener = fn;
  },
  startBackgroundLocation: () => mockBgStart(),
  stopBackgroundLocation: () => mockBgStop(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
const mockApi = jest.mocked(api);

const T = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
  id: 't-1',
  status: 'requesting',
  version: 3,
  serverNow: new Date().toISOString(),
  requestRadiusKm: 20,
  fallbackRadiusKm: 30,
  fallbackReason: null,
  currentRound: {
    roundNo: 1,
    sentAt: '2026-11-26T03:00:00Z',
    respondUntil: '2026-11-26T03:02:00Z',
  },
  requests: [
    {
      id: 11,
      hospitalId: 101,
      hospitalName: '순천향대 천안병원',
      lat: 36.8,
      lng: 127.13,
      status: 'approved',
      closeReason: null,
      etaMin: 9,
      erBeds: '3/12',
      memo: '정문 쪽',
      extraMemo: null,
      reason: null,
      reasonText: null,
      approvedAt: '2026-11-26T03:00:40Z',
      prevApprovedRecheck: false,
      version: 2,
    },
    {
      id: 12,
      hospitalId: 102,
      hospitalName: '단국대병원',
      lat: 36.84,
      lng: 127.17,
      status: 'rejected',
      closeReason: null,
      etaMin: null,
      erBeds: null,
      memo: null,
      extraMemo: null,
      reason: 'er_bed',
      reasonText: null,
      approvedAt: null,
      prevApprovedRecheck: false,
      version: 2,
    },
  ],
  phoneTarget: null,
  confirmedHospital: null,
  canReRequest: false,
  destinationChangeUsed: false,
  navDeviceId: null,
  etaMin: null,
  lastSentAssessmentSeq: 1,
  excludedHospitalIds: [],
  requestedGrade: 1,
  ...patch,
});

beforeEach(() => {
  jest.useRealTimers();
  mockApi.mockReset();
  __resetEngineForTest();
  teamStore.reset();
  setTokenHooks({
    get: () => ({ accessToken: 'a', refreshToken: 'r' }),
    set: () => {},
    lost: () => {},
  });
});

test('서버 이송 건 → 화면 상태 (병원 이름·병상·거절 사유 문구·등급)', () => {
  apply(T(), 'ios-me');
  const e = getEngine();
  expect(e).toMatchObject({
    transportId: 't-1',
    status: 'requesting',
    version: 3,
    radius: 20,
    round: 1,
    grade: '대학병원급',
  });
  expect(e.hreqs.map((h) => [h.hospitalId, h.status, h.reason ?? null, h.note ?? null])).toEqual([
    ['101', 'approved', null, '정문 쪽'],
    ['102', 'rejected', '응급실 병상 부족', null],
  ]);
  expect(hospital('101')).toMatchObject({ name: '순천향대 천안병원', er: '3/12', min: 9 });
  expect(e.history.at(-1)).toMatchObject({ from: null, to: 'requesting', label: '병원에 요청' });
});

test('예비 추천에서는 넓힌 반경, 확정 병원 승인 취소면 경보, 담당 단말 판정', () => {
  apply(T({ status: 'fallback', fallbackReason: 'all_rejected' }), 'ios-me');
  expect(getEngine()).toMatchObject({ radius: 30, fallbackReason: 'all_rejected' });
  apply(
    T({
      status: 'moving',
      navDeviceId: 'ios-me',
      canReRequest: true,
      confirmedHospital: {
        id: 101,
        name: '순천향대 천안병원',
        erPhone: '041-1',
        memo: null,
        extraMemo: null,
        entrance: { lat: 36.8, lng: 127.13 },
        requestStatus: 'confirmed',
        closeReason: null,
      },
    }),
    'ios-me',
  );
  expect(getEngine()).toMatchObject({
    navIsMe: true,
    alert: '순천향대 천안병원이(가) 승인을 취소했어요',
    confirmedId: '101',
  });
});

test('이송 요청: 환자 이름·연락처 없이 평가 항목만, 이송 건 id 는 UUID', async () => {
  mockApi.mockResolvedValueOnce(T()).mockResolvedValue({ radiusKm: 20, map: [] });
  const r = await actions.create('대학병원급', {
    ...emptyPatient,
    complaint: '흉통',
    sex: '남',
    age: '60대',
    consciousness: '명료',
  });
  expect(r.ok).toBe(true);
  const [method, path, opt] = mockApi.mock.calls[0]!;
  expect([method, path]).toEqual(['POST', '/transports']);
  const body = (opt as { body: Record<string, unknown> }).body;
  expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(body).toMatchObject({
    radiusKm: 20,
    location: { lat: 36.815, lng: 127.1139 },
    locationConsent: true,
    requestedGrade: 1,
  });
  const text = JSON.stringify(body);
  for (const banned of ['name', 'phone', 'address', 'rrn', 'juminNo'])
    expect(text).not.toContain(`"${banned}"`);
});

test('확정: 승인된 요청 id + 버전 + Idempotency-Key', async () => {
  apply(T(), 'ios-me');
  mockApi.mockResolvedValueOnce(undefined).mockResolvedValueOnce(T({ status: 'moving' }));
  await actions.confirm('101');
  const [, path, opt] = mockApi.mock.calls[0]!;
  expect(path).toBe('/transports/t-1/confirm');
  expect(opt).toMatchObject({ body: { hospitalRequestId: 11, version: 3 } });
  expect((opt as { headers: Record<string, string> }).headers['Idempotency-Key']).toMatch(
    /^[0-9a-f-]{36}$/,
  );
});

test('승인 안 된 병원은 확정하지 않는다', async () => {
  apply(T(), 'ios-me');
  const r = await actions.confirm('102');
  expect(r).toEqual({ ok: false, error: '승인 상태가 아니에요' });
  // 확정은 보내지 않고, 최신 상태만 다시 읽는다
  expect(mockApi.mock.calls.some((c) => String(c[1]).endsWith('/confirm'))).toBe(false);
});

test('도착: 상태는 그대로인데 버전만 올라 거절되면 최신 버전으로 한 번 더', async () => {
  apply(T({ status: 'moving', version: 5 }), 'ios-me');
  mockApi
    .mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', '바뀌었어요'))
    .mockResolvedValueOnce(T({ status: 'moving', version: 6 })) // 다시 읽기
    .mockResolvedValueOnce(undefined) // 새 버전으로 도착
    .mockResolvedValueOnce(T({ status: 'arrived', version: 7 }));
  const r = await actions.arrive();
  expect(r.ok).toBe(true);
  expect(mockApi.mock.calls[2]).toEqual([
    'POST',
    '/transports/t-1/arrive',
    { body: { method: 'button', version: 6 } },
  ]);
  expect(getEngine().status).toBe('arrived');
});

test('팀원이 먼저 상태를 바꿨으면 다시 보내지 않는다 (덮어쓰기 방지, SFR-160)', async () => {
  apply(T({ status: 'moving', version: 5 }), 'ios-me');
  mockApi
    .mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', '다른 팀원이 먼저 처리했어요'))
    .mockResolvedValue(T({ status: 'cancelled', version: 6 }));
  const r = await actions.arrive();
  expect(r).toEqual({ ok: false, error: '다른 팀원이 먼저 처리했어요' });
  expect(mockApi.mock.calls.filter((c) => c[1] === '/transports/t-1/arrive')).toHaveLength(1);
});

test('다시 읽기는 몰려도 한 번에 하나씩 (도중에 또 오면 끝나고 한 번 더)', async () => {
  apply(T(), 'ios-me');
  let resolve!: () => void;
  mockApi
    .mockImplementationOnce(() => new Promise((r) => (resolve = () => r(T()))))
    .mockResolvedValue(T());
  const a = refresh();
  void refresh();
  void refresh();
  await new Promise((r) => setTimeout(r, 0)); // 첫 요청이 나갈 때까지
  resolve();
  await a;
  expect(mockApi).toHaveBeenCalledTimes(2);
});

test('진행 중 이송이 없어지면(NO_ACTIVE_TRANSPORT) 화면을 비운다', async () => {
  apply(T(), 'ios-me');
  mockApi.mockRejectedValue(new ApiError(404, 'NO_ACTIVE_TRANSPORT', '없음'));
  await refresh();
  expect(getEngine().status).toBeNull();
});

test('이벤트가 몰려 오면 0.12초 모아 한 번만 다시 읽는다', async () => {
  jest.useFakeTimers();
  mockApi.mockRejectedValue(new ApiError(404, 'NO_ACTIVE_TRANSPORT', '없음'));
  const stop = startTransportSync();
  await jest.advanceTimersByTimeAsync(0);
  mockApi.mockReset();
  mockApi.mockResolvedValue(T());
  apply(T(), 'ios-me');
  let seq = 1000;
  const ev = (data: Record<string, unknown>) => ({
    seq: ++seq,
    room: 'team:1',
    occurredAt: '',
    serverNow: new Date().toISOString(),
    data,
  });
  dispatch('request.approved', ev({ transportId: 't-1' }));
  dispatch('request.approved', ev({ transportId: 't-1' }));
  dispatch('request.rejected', ev({ transportId: 't-1' }));
  await jest.advanceTimersByTimeAsync(150);
  expect(mockApi.mock.calls.filter((c) => c[1] === '/transports/t-1')).toHaveLength(1);
  stop();
});

test('운전 역할이면 이동 시작 때 경로 안내 담당을 맡고, 담당이면 위치(좌표·속도·시각만)를 보낸다', async () => {
  teamStore.set({
    team: {
      id: 1,
      code: '1',
      members: [{ paramedicId: 1, name: '김', role: 'driver', isMe: true }],
    },
  });
  const entrance = { lat: 36.8, lng: 127.13 };
  const confirmedHospital = {
    id: 101,
    name: '순천향대',
    erPhone: null,
    memo: null,
    extraMemo: null,
    entrance,
    requestStatus: 'confirmed' as const,
    closeReason: null,
  };
  mockApi
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue(T({ status: 'moving', navDeviceId: 'ios-me', confirmedHospital }));
  apply(T({ status: 'moving', confirmedHospital }), 'ios-me');
  await new Promise((r) => setTimeout(r, 20));
  expect(mockApi.mock.calls[0]).toEqual([
    'POST',
    '/transports/t-1/nav-device',
    { body: { deviceId: 'ios-me', version: 3 } },
  ]);
  // 담당이 되면 OS 백그라운드 위치를 켜고(SFR-079), OS 가 넘겨준 위치를 서버로 보낸다
  expect(mockBgStart).toHaveBeenCalled();
  mockBgListener!([{ lat: 36.81, lng: 127.12, accuracyM: 5, speedKmh: 40, at: Date.now() }]);
  await new Promise((r) => setTimeout(r, 20));
  const loc = mockApi.mock.calls.find((c) => c[1] === '/transports/t-1/locations');
  expect(loc).toBeTruthy();
  const body = (
    loc![2] as { body: { deviceId: string; points: Record<string, unknown>[]; etaMin?: number } }
  ).body;
  expect(body.deviceId).toBe('ios-me');
  expect(Object.keys(body.points[0]!).sort()).toEqual(['lat', 'lng', 'recordedAt', 'speedKmh']);
  expect(typeof body.etaMin).toBe('number'); // 처음에는 남은 분도 같이
  actions.reset();
  // 이송이 끝나면(화면 비우기) 백그라운드 위치도 멈춘다
  expect(mockBgStop).toHaveBeenCalled();
});

test('못 보낸 위치는 모아 두었다가 다음에 한꺼번에 보낸다 (끊김 대비)', async () => {
  teamStore.set({
    team: {
      id: 1,
      code: '1',
      members: [{ paramedicId: 1, name: '김', role: 'driver', isMe: true }],
    },
  });
  const confirmedHospital = {
    id: 101,
    name: '순천향대',
    erPhone: null,
    memo: null,
    extraMemo: null,
    entrance: { lat: 36.8, lng: 127.13 },
    requestStatus: 'confirmed' as const,
    closeReason: null,
  };
  const moving = T({ status: 'moving', navDeviceId: 'ios-me', confirmedHospital });
  mockApi.mockImplementation(async (_m: string, path: string) => {
    if (path === '/transports/t-1/locations') throw new Error('offline');
    return moving;
  });
  apply(moving, 'ios-me');
  await new Promise((r) => setTimeout(r, 20));
  const fix = (n: number) => ({
    lat: 36.81 + n / 1000,
    lng: 127.12,
    accuracyM: 5,
    speedKmh: 40,
    at: Date.now() + n,
  });
  mockBgListener!([fix(1)]);
  await new Promise((r) => setTimeout(r, 10));
  mockBgListener!([fix(2)]);
  await new Promise((r) => setTimeout(r, 10));
  mockApi.mockClear();
  mockApi.mockResolvedValue(moving);
  mockBgListener!([fix(3)]);
  await new Promise((r) => setTimeout(r, 20));
  const sent = mockApi.mock.calls.find((c) => c[1] === '/transports/t-1/locations');
  expect((sent![2] as { body: { points: unknown[] } }).body.points).toHaveLength(3);
  actions.reset();
});

describe('환자 정보 → 평가 항목', () => {
  test('모르는 칸은 확인 불가로 표시하고 범위 밖 값은 보내지 않는다', () => {
    const a = toAssessment({
      ...emptyPatient,
      complaint: '흉통',
      sex: '여',
      age: UNKNOWN,
      consciousness: '통증에 반응',
      painScore: '11',
      temp: '50',
      ktas: '2',
      trauma: '없음',
      pulse: '120',
    });
    expect(a).toMatchObject({
      chiefComplaint: '흉통',
      sex: 'F',
      ageBand: UNKNOWN,
      consciousness: 'pain',
      painScore: null,
      temp: null,
      ktas: 2,
      trauma: 'no',
      pulse: 120,
    });
    expect(a.unknownFields).toEqual(['ageBand']);
  });
  test('빈 증상은 확인 불가, 성별 모름은 U', () => {
    expect(toAssessment(emptyPatient)).toMatchObject({
      chiefComplaint: UNKNOWN,
      sex: 'U',
      consciousness: 'unknown',
      trauma: 'unknown',
    });
  });
});
