import { api } from '../api/client';
import {
  acceptInvite,
  addIncoming,
  clearTeam,
  createTeam,
  inviteLeft,
  joinTeam,
  parseTeamQr,
  refreshTeam,
  startDuty,
  teamStore,
  type Team,
} from '../duty/team';
import { gateTarget, type GateInput } from '../gate';
import { acceptSeq } from '../realtime/socket';
import { ApiError } from '../api/client';

jest.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void m.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void m.delete(k)),
  };
});
jest.mock('../realtime/socket', () => ({
  ...jest.requireActual('../realtime/socket'),
  reconnectRealtime: jest.fn(),
}));
jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client');
  return { ...actual, api: jest.fn() };
});
const mockApi = jest.mocked(api);

const team = (id = 12, extra: Partial<Team> = {}): Team => ({
  id,
  code: '4821',
  qrToken: 'qr-abc',
  maxMembers: 4,
  members: [{ paramedicId: 1, name: '김도윤', rank: '소방교', role: 'care', isMe: true }],
  ...extra,
});

beforeEach(async () => {
  mockApi.mockReset();
  await clearTeam();
});

test('팀 만들기 → 코드·QR 이 생기고, 근무 시작 전 상태', async () => {
  mockApi.mockResolvedValueOnce(team());
  expect(await createTeam('처치')).toBeNull();
  expect(mockApi).toHaveBeenCalledWith('POST', '/teams', { body: { role: 'care' } });
  expect(teamStore.get()).toMatchObject({ started: false, isCreator: true });
  await startDuty();
  expect(teamStore.get().started).toBe(true);
});

test('두 번 눌러도 팀 만들기는 한 번만 보낸다', async () => {
  mockApi.mockResolvedValue(team());
  await Promise.all([createTeam('처치'), createTeam('처치')]);
  expect(mockApi).toHaveBeenCalledTimes(1);
});

test('코드·QR 참여: 운전은 driver 로 보낸다', async () => {
  mockApi.mockResolvedValue(team());
  await joinTeam({ code: '4821' }, '운전');
  expect(mockApi).toHaveBeenCalledWith('POST', '/teams/join', {
    body: { code: '4821', role: 'driver' },
  });
  await clearTeam();
  await joinTeam({ qrToken: 'qr-abc' }, '처치');
  expect(mockApi).toHaveBeenLastCalledWith('POST', '/teams/join', {
    body: { qrToken: 'qr-abc', role: 'care' },
  });
});

test('앱을 다시 켰을 때: 기억한 팀이면 그 상태, 기억이 없으면 이미 근무 중으로 본다', async () => {
  mockApi.mockResolvedValueOnce(team(12));
  await createTeam('처치'); // 기억: 팀 12, 시작 안 함
  teamStore.set({ team: 'loading' }); // 앱을 다시 켬
  mockApi.mockResolvedValueOnce(team(12));
  await refreshTeam();
  expect(teamStore.get().started).toBe(false);

  await clearTeam(); // 기억 없음
  mockApi.mockResolvedValueOnce(team(99));
  await refreshTeam();
  expect(teamStore.get().started).toBe(true);
});

test('팀이 없으면(404) 근무 시작 화면, 오프라인이면 빈 화면에 갇히지 않는다', async () => {
  mockApi.mockRejectedValueOnce(new ApiError(404, 'NOT_IN_TEAM', '팀이 없어요'));
  await refreshTeam();
  expect(teamStore.get().team).toBeNull();
  await clearTeam();
  mockApi.mockRejectedValueOnce(new ApiError(0, 'NETWORK', '연결 안 됨'));
  await refreshTeam();
  expect(teamStore.get().team).toBeNull();
});

test('초대 수락: 운전이 이미 있으면 처치로 다시 보내고 바로 근무 시작', async () => {
  const inv = {
    inviteId: 7,
    teamCode: '4821',
    fromName: '이구급',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  addIncoming(inv);
  addIncoming(inv); // 같은 초대는 한 번만
  expect(teamStore.get().incoming).toHaveLength(1);
  mockApi
    .mockRejectedValueOnce(new ApiError(409, 'DRIVER_TAKEN', '운전 있음'))
    .mockResolvedValueOnce(team());
  expect(await acceptInvite(inv, '운전')).toBeNull();
  expect(mockApi.mock.calls[1]).toEqual(['POST', '/invites/7/accept', { body: { role: 'care' } }]);
  expect(teamStore.get()).toMatchObject({ started: true, incoming: [] });
});

test('이미 팀이 있으면 초대를 수락할 수 없다', async () => {
  mockApi.mockResolvedValueOnce(team());
  await createTeam('처치');
  const inv = { inviteId: 8, teamCode: '1111', fromName: 'x', expiresAt: new Date().toISOString() };
  expect(await acceptInvite(inv, '처치')).toMatch('이미 팀에 있어요');
});

test('QR: 우리 앱 팀 QR 만 받는다', () => {
  expect(parseTeamQr('savetime:team:qr-abc')).toBe('qr-abc');
  expect(parseTeamQr('https://example.com')).toBeNull();
  expect(parseTeamQr('savetime:team:')).toBeNull();
});

test('초대 남은 시간은 0 아래로 안 내려간다', () => {
  const inv = { inviteId: 1, teamCode: '1', fromName: 'a', expiresAt: '2026-11-26T03:05:00Z' };
  expect(inviteLeft(inv, Date.parse('2026-11-26T03:04:00Z'))).toBe(60_000);
  expect(inviteLeft(inv, Date.parse('2026-11-26T03:06:00Z'))).toBe(0);
});

test('실시간 번호: 이미 받은 번호는 버리고, 0 번(강제 로그아웃)은 늘 받는다', () => {
  expect(acceptSeq(null, 5)).toEqual({ accept: true, last: 5 });
  expect(acceptSeq(5, 5)).toEqual({ accept: false, last: 5 });
  expect(acceptSeq(5, 0)).toEqual({ accept: true, last: 5 });
});

describe('화면 순서: 근무', () => {
  const g: GateInput = {
    appVersion: '1.0.0',
    minAppVersion: '1.0.0',
    consent: 'agreed',
    permissions: { location: 'granted', notify: 'granted' },
    auth: { status: 'signedIn', me: { id: 1, status: 'approved' } },
  };
  test.each([
    [{ team: 'loading', started: false }, 'loading'],
    [{ team: 'none', started: false }, 'duty'],
    [{ team: 'joined', started: false }, 'duty'],
    [{ team: 'joined', started: true }, 'home'],
  ] as const)('%o → %s', (duty, want) => expect(gateTarget({ ...g, duty })).toBe(want));
});
