import { act, render, screen } from '@testing-library/react-native';
import { ApiError, api } from '../api/client';
import { __resetDbForTest } from '../offline/db';
import {
  KEEP_PER_REGION,
  latestCards,
  regionOf,
  saveCards,
  type CachedCard,
} from '../offline/cache';
import { __resetNetForTest, markOffline, markOnline, netStore } from '../offline/net';
import { NetBanner } from '../offline/NetBanner';
import { pending } from '../offline/queue';
import {
  __resetEngineForTest,
  actions,
  apply,
  getEngine,
  loadNearby,
  startTransportSync,
  type ServerTransport,
} from '../transport/engine';
import { emptyPatient } from '../transport/patient';

// expo-sqlite 를 메모리 표 3개로 흉내 (이 앱이 쓰는 SQL 모양만)
jest.mock('expo-sqlite', () => {
  const t: Record<string, Record<string, unknown>[]> = {
    journal: [],
    hospital_cache: [],
    offline_queue: [],
  };
  let auto = 1;
  const db = {
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, ...a: unknown[]) => {
      if (sql.startsWith('INSERT INTO hospital_cache'))
        t.hospital_cache.push({ id: auto++, region: a[0], saved_at: a[1], data: a[2] });
      else if (sql.startsWith('DELETE FROM hospital_cache')) {
        const mine = t.hospital_cache
          .filter((r) => r.region === a[0])
          .sort(
            (x, y) =>
              (y.saved_at as number) - (x.saved_at as number) ||
              (y.id as number) - (x.id as number),
          );
        const keep = new Set(mine.slice(0, a[2] as number).map((r) => r.id));
        t.hospital_cache = t.hospital_cache.filter((r) => r.region !== a[0] || keep.has(r.id));
      } else if (sql.startsWith('INSERT INTO offline_queue'))
        t.offline_queue.push({ seq: auto++, data: a[0] });
      else if (sql.startsWith('DELETE FROM offline_queue'))
        t.offline_queue = t.offline_queue.filter((r) => r.seq !== a[0]);
    }),
    getAllAsync: jest.fn(async (sql: string) =>
      sql.includes('offline_queue') ? [...t.offline_queue] : [],
    ),
    getFirstAsync: jest.fn(async (sql: string, ...a: unknown[]) => {
      const rows = t.hospital_cache
        .filter((r) => !sql.includes('region = ?') || r.region === a[0])
        .sort(
          (x, y) =>
            (y.saved_at as number) - (x.saved_at as number) || (y.id as number) - (x.id as number),
        );
      return rows[0] ?? null;
    }),
  };
  return { openDatabaseAsync: jest.fn(async () => db), __tables: t };
});
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), api: jest.fn() }));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'ios-me') }));
jest.mock('../transport/location', () => ({
  ...jest.requireActual('../transport/location'),
  currentLocation: jest.fn(async () => ({ lat: 36.81, lng: 127.11 })),
}));
const mockApi = jest.mocked(api);
const NET = () => new ApiError(0, 'NETWORK', '연결 안 됨');

const card = (id: number, er: string | null = '2/8'): CachedCard => ({
  id,
  name: `병원${id}`,
  lat: 36.8,
  lng: 127.1,
  distanceKm: id,
  etaMin: 5,
  beds: { er, icu: null, or: null },
  bedsSourceTime: null,
  capabilityCount: { available: 1, total: 2 },
  erPhone: `041-000-000${id}`,
  grade: 2,
  collectedAt: '2026-11-27T05:00:00Z',
  stale: false,
});
const T = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
  id: 't-1',
  status: 'fallback',
  version: 3,
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
const tables = () =>
  (jest.requireMock('expo-sqlite') as { __tables: Record<string, unknown[]> }).__tables;

beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  __resetNetForTest();
  __resetDbForTest();
  const tb = tables();
  for (const k of Object.keys(tb)) tb[k]!.length = 0;
});

test('병원 목록은 지역별 최근 10건만 저장 (SFR-059)', async () => {
  const at = { lat: 36.81, lng: 127.11 };
  for (let i = 0; i < 12; i++) await saveCards(at, [card(i + 1)], 1000 + i);
  expect(tables().hospital_cache!.length).toBe(KEEP_PER_REGION);
  expect((await latestCards(at))!.savedAt).toBe(1011);
  expect(regionOf({ lat: 36.81, lng: 127.11 })).toBe(regionOf({ lat: 36.82, lng: 127.12 })); // 약 5km 칸
});

test('목록 조회가 실패하면 지난 목록 유지, 아예 없으면 휴대폰 저장본 (SFR-008 · 061)', async () => {
  await saveCards({ lat: 36.81, lng: 127.11 }, [card(1), card(2), card(3, null)], 500);
  apply(T(), 'ios-me');
  mockApi.mockRejectedValue(NET());
  await loadNearby();
  expect(getEngine().nearby).toEqual(['1', '2']);
  expect(getEngine().noBed).toEqual(['3']);
  expect(getEngine().cachedAt).toBe(500);
});

test('통신이 끊긴 채 요청하면 병원에는 안 보내고 오프라인 예비 추천 + 기록 (SFR-099)', async () => {
  await saveCards({ lat: 36.81, lng: 127.11 }, [card(1), card(2)], 500);
  mockApi.mockRejectedValue(NET());
  const r = await actions.create(null, { ...emptyPatient, complaint: '흉통' }, 20);
  expect(r.ok).toBe(true);
  expect(getEngine()).toMatchObject({
    status: 'fallback',
    fallbackReason: 'offline',
    offlineCreated: true,
    nearby: ['1', '2'],
  });
  const q = await pending();
  expect(q.map((x) => x.rec.kind)).toEqual(['create_fallback']);
  expect(q[0]!.rec).toMatchObject({ radiusKm: 20, location: { lat: 36.81, lng: 127.11 } });
  expect(JSON.stringify(q[0]!.rec)).not.toMatch(/"name"|phone|address/); // 환자 식별정보 없음
});

test('끊긴 동안 전화 확인 → 수용 확정 → 도착이 순서대로 쌓이고, 화면은 먼저 바뀐다', async () => {
  await saveCards({ lat: 36.81, lng: 127.11 }, [card(1)], 500);
  apply(T(), 'ios-me');
  mockApi.mockRejectedValue(NET());
  await loadNearby();
  await actions.startPhone('1');
  expect(getEngine()).toMatchObject({ status: 'phone_check', phoneTarget: '1' });
  await actions.phoneAccepted();
  expect(getEngine()).toMatchObject({ status: 'moving', confirmedId: '1' });
  await actions.arrive();
  expect(getEngine().status).toBe('arrived');
  const q = await pending();
  expect(q.map((x) => `${x.rec.kind}:${x.rec.result ?? x.rec.method ?? ''}`)).toEqual([
    'phone_check:accepted',
    'arrive:button',
  ]);
});

test('확정·취소는 끊긴 동안 쌓지 않고 알려 준다', async () => {
  apply(T({ status: 'moving' }), 'ios-me');
  mockApi.mockRejectedValue(NET());
  const r = await actions.cancel();
  expect(r).toEqual({
    ok: false,
    error: '통신이 끊겨 지금은 할 수 없어요. 연결되면 다시 해 주세요',
  });
  expect(await pending()).toHaveLength(0);
});

test('복구되면 밀린 기록을 발생 순서대로 올리고, 받은 기록은 지운다 (SFR-099 · 068)', async () => {
  await saveCards({ lat: 36.81, lng: 127.11 }, [card(1)], 500);
  apply(T(), 'ios-me');
  mockApi.mockRejectedValue(NET());
  const stop = startTransportSync();
  await act(async () => {
    markOffline();
    await actions.startPhone('1');
    await actions.phoneRejected('er_bed');
    await actions.startPhone('1');
    await actions.phoneAccepted();
  });
  const q = await pending();
  expect(q.map((x) => x.rec.result)).toEqual(['rejected', 'accepted']);
  mockApi.mockReset();
  mockApi.mockImplementation(async (_m: string, path: string) => {
    if (path === '/transports/sync')
      return {
        results: q.map((x) => ({ clientRecordId: x.rec.clientRecordId, outcome: 'applied' })),
        transport: T({ status: 'moving', version: 5 }),
        alert: false,
      };
    if (path.startsWith('/transports/t-1/recommendations'))
      return { radiusKm: 20, items: [card(2)], map: [card(2)], noBedInfo: [], emptyGuide: null };
    if (path === '/transports/t-1') return T({ status: 'moving', version: 5 });
    return {};
  });
  await act(async () => {
    markOnline();
    await new Promise((r) => setTimeout(r, 30));
  });
  const sync = mockApi.mock.calls.find((c) => c[1] === '/transports/sync')!;
  const sent = (
    sync[2] as {
      body: { records: { clientRecordId: string; result: string; rejectReason?: string }[] };
    }
  ).body.records;
  expect(sent.map((r) => r.result)).toEqual(['rejected', 'accepted']); // 발생 순서
  expect(sent[0]!.rejectReason).toBe('er_bed');
  expect(await pending()).toHaveLength(0); // 받은 기록은 지움
  expect(getEngine()).toMatchObject({ status: 'moving', version: 5, offlineCreated: false });
  expect(netStore.get().recoveredAt).not.toBeNull(); // '최신 정보로 갱신되었습니다'
  stop();
});

test('오프라인 배너 · 복구 알림 (SFR-064 · 068)', async () => {
  netStore.set({ online: false });
  await render(<NetBanner />);
  expect(screen.getByText('오프라인 — 저장된 정보입니다')).toBeTruthy();
  expect(screen.getByText('이동 전 반드시 병원에 직접 전화로 확인하세요')).toBeTruthy();
  await act(async () => netStore.set({ online: true, recoveredAt: Date.now() }));
  expect(screen.getByText('최신 정보로 갱신되었습니다')).toBeTruthy();
});
