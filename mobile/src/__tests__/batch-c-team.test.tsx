import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PatientScreen from '../../app/patient';
import { ApiError, api, setTokenHooks } from '../api/client';
import { teamStore } from '../duty/team';
import { dispatch } from '../realtime/socket';
import { applyDraft, draftChanges } from '../transport/draftMap';
import {
  __resetEngineForTest,
  actions,
  apply,
  getEngine,
  setRouteOpener,
  type ServerTransport,
} from '../transport/engine';
import { emptyPatient, UNKNOWN } from '../transport/patient';
import { patientStore } from '../transport/patientStore';
import {
  __resetDraftForTest,
  draftStore,
  editPatient,
  pull,
  startDraftSync,
} from '../transport/teamDraft';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), api: jest.fn() }));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'ios-me') }));
const mockFix = jest.fn(async () => ({
  lat: 36.8,
  lng: 127.1,
  accuracyM: 5,
  speedKmh: 0,
  at: Date.now(),
}));
jest.mock('../transport/location', () => ({
  ...jest.requireActual('../transport/location'),
  currentFix: () => mockFix(),
  currentLocation: async () => ({ lat: 36.8, lng: 127.1 }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), push: jest.fn() }),
  usePathname: () => '/patient',
}));
const mockApi = jest.mocked(api);

const team = (role: 'driver' | 'care', others: { role: 'driver' | 'care' }[] = []) =>
  teamStore.set({
    team: {
      id: 1,
      code: '1',
      members: [
        { paramedicId: 1, name: '나', role, isMe: true },
        ...others.map((o, i) => ({
          paramedicId: i + 2,
          name: `팀원${i}`,
          role: o.role,
          isMe: false,
        })),
      ],
    },
    started: true,
  });

beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  __resetEngineForTest();
  __resetDraftForTest();
  teamStore.reset();
  patientStore.reset();
  mockFix.mockResolvedValue({ lat: 36.8, lng: 127.1, accuracyM: 5, speedKmh: 0, at: Date.now() });
  setTokenHooks({
    get: () => ({ accessToken: 'a', refreshToken: 'r' }),
    set: () => {},
    lost: () => {},
  });
});

describe('화면 칸 ↔ 서버 작성 중 정보 (SFR-114)', () => {
  test('바뀐 칸만, 서버 형식으로 (빈 칸은 지우기, 확인 불가 목록 함께)', () => {
    const prev = { ...emptyPatient, bp: '120/80' };
    const next = {
      ...prev,
      bp: '160/95',
      pulse: '110',
      sex: '남',
      consciousness: '말에 반응',
      age: UNKNOWN,
    };
    expect(draftChanges(prev, next)).toEqual({
      bp: '160/95',
      pulse: 110,
      sex: 'M',
      consciousness: 'verbal',
      ageBand: null,
      unknownFields: ['ageBand'],
    });
    expect(draftChanges(prev, { ...prev, bp: '' })).toEqual({ bp: null });
    expect(draftChanges(prev, prev)).toBeNull();
  });

  test('서버 값을 화면 값으로, 고친 칸만', () => {
    const p = { ...emptyPatient, complaint: '내가 쓴 주 증상', trauma: '왼팔 열상' };
    const got = applyDraft(
      p,
      {
        chiefComplaint: '다른 값',
        bp: '160/95',
        sex: 'F',
        trauma: 'yes',
        unknownFields: ['ageBand'],
      },
      ['bp', 'sex', 'trauma'],
    );
    expect(got).toMatchObject({
      complaint: '내가 쓴 주 증상',
      bp: '160/95',
      sex: '여',
      trauma: '왼팔 열상',
    });
    expect(applyDraft(emptyPatient, { ageBand: null, unknownFields: ['ageBand'] }).age).toBe(
      UNKNOWN,
    );
  });
});

describe('팀원과 함께 입력', () => {
  test('내가 고치면 0.5초 모아 바뀐 칸만 PATCH (운전이면 속도도)', async () => {
    team('driver');
    mockApi.mockResolvedValue({ version: 3, assessment: {} });
    editPatient({ ...emptyPatient, bp: '160/95' });
    editPatient({ ...patientStore.get().patient, pulse: '110' });
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(mockApi).toHaveBeenCalledWith('PATCH', '/teams/current/draft', {
      body: { baseVersion: 0, changes: { bp: '160/95', pulse: 110 }, speedKmh: 0 },
    });
  });

  test('팀원이 고치면 그 칸만 내 화면에 + 안내 (내가 보낸 이벤트는 무시)', async () => {
    team('care');
    patientStore.set({ patient: { ...emptyPatient, complaint: '흉통' } });
    mockApi.mockResolvedValue({
      version: 5,
      assessment: { chiefComplaint: '흉통', bp: '160/95', pulse: null },
    });
    const stop = startDraftSync();
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    mockApi.mockClear();
    mockApi.mockResolvedValue({
      version: 6,
      assessment: { chiefComplaint: '흉통', bp: '160/95', pulse: 88 },
    });
    await act(async () => {
      dispatch('draft.updated', {
        seq: 7001,
        room: 'team:1',
        occurredAt: '',
        serverNow: new Date().toISOString(),
        data: { version: 6, fields: ['pulse'], byName: '이하준', overwritten: [] },
      });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(patientStore.get().patient).toMatchObject({
      complaint: '흉통',
      bp: '160/95',
      pulse: '88',
    });
    expect(draftStore.get().notice).toBe('이하준 대원이 맥박을(를) 입력했어요');
    mockApi.mockClear();
    dispatch('draft.updated', {
      seq: 7002,
      room: 'team:1',
      occurredAt: '',
      serverNow: new Date().toISOString(),
      data: { version: 6, fields: ['pulse'], byName: '나', overwritten: [] },
    });
    expect(mockApi).not.toHaveBeenCalled();
    stop();
  });

  test('같은 칸을 동시에 고치면 알린다', async () => {
    team('care');
    mockApi.mockResolvedValue({
      version: 4,
      assessment: {},
      overwritten: [{ field: 'bp', prevByName: '이하준' }],
    });
    editPatient({ ...emptyPatient, bp: '150/90' });
    await waitFor(
      () =>
        expect(draftStore.get().notice).toBe(
          '같은 칸을 팀원도 고쳤어요 · 나중 값으로 저장: 혈압(이하준)',
        ),
      { timeout: 2000 },
    );
  });

  test('운전 대원 주행 중이면 서버가 막고 → 잠금 + 서버 값으로 되돌림 (SFR-115)', async () => {
    team('driver');
    patientStore.set({ patient: { ...emptyPatient, bp: '120/80' } });
    mockApi.mockImplementation(async (m: string) => {
      if (m === 'PATCH') throw new ApiError(423, 'DRIVER_INPUT_LOCKED', '주행 중');
      return { version: 2, assessment: { bp: '120/80' } };
    });
    editPatient({ ...patientStore.get().patient, bp: '200/100' });
    await waitFor(() => expect(draftStore.get().locked).toBe(true), { timeout: 2000 });
    expect(draftStore.get().notice).toBe('주행 중에는 팀원이 입력해요');
    expect(patientStore.get().patient.bp).toBe('120/80');
  });

  test('입력 화면: 운전 대원이 시속 10km 이상이면 잠금 안내', async () => {
    team('driver');
    mockFix.mockResolvedValue({
      lat: 36.8,
      lng: 127.1,
      accuracyM: 5,
      speedKmh: 40,
      at: Date.now(),
    });
    mockApi.mockResolvedValue({ count: 3 });
    await render(<PatientScreen />);
    expect(
      await screen.findByText('주행 중에는 팀원이 입력해요 · 차가 서면 다시 입력할 수 있어요'),
    ).toBeTruthy();
  });

  test('직전 환자 정보로 채워졌으면 지우기 (SFR-157)', async () => {
    team('care');
    mockApi.mockImplementation(async (m: string, path: string) =>
      path === '/teams/current/draft' && m === 'GET'
        ? { version: 3, assessment: { chiefComplaint: '흉통' }, prefilledFromTransportId: 't-old' }
        : { count: 3 },
    );
    await act(async () => pull());
    expect(patientStore.get().patient.complaint).toBe('흉통');
    await render(<PatientScreen />);
    await fireEvent.press(screen.getByRole('button', { name: '직전 환자 정보 지우기' }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith('DELETE', '/teams/current/draft'));
    expect(patientStore.get().patient.complaint).toBe('');
  });
});

describe('경로 안내 담당 (SFR-132)', () => {
  const T = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
    id: 't-1',
    status: 'moving',
    version: 2,
    serverNow: '',
    requestRadiusKm: 20,
    fallbackRadiusKm: 20,
    fallbackReason: null,
    currentRound: null,
    requests: [],
    phoneTarget: null,
    confirmedHospital: {
      id: 101,
      name: 'B병원',
      erPhone: null,
      memo: null,
      extraMemo: null,
      entrance: { lat: 36.8, lng: 127.13 },
      requestStatus: 'confirmed',
      closeReason: null,
    },
    canReRequest: false,
    destinationChangeUsed: false,
    navDeviceId: null,
    etaMin: 9,
    lastSentAssessmentSeq: 0,
    excludedHospitalIds: [],
    requestedGrade: null,
    ...patch,
  });

  test('운전 대원 폰이 맡고, 맡으면 길 안내를 한 번 저절로 연다', async () => {
    team('driver');
    const opened: string[] = [];
    setRouteOpener((_to, name) => opened.push(name));
    mockApi.mockResolvedValueOnce(undefined).mockResolvedValue(T({ navDeviceId: 'ios-me' }));
    apply(T(), 'ios-me');
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('POST', '/transports/t-1/nav-device', expect.anything()),
    );
    await waitFor(() => expect(opened).toEqual(['B병원']));
    apply(T({ navDeviceId: 'ios-me', etaMin: 8 }), 'ios-me');
    expect(opened).toEqual(['B병원']); // 한 번만
    actions.reset();
    setRouteOpener(() => {});
  });

  test('팀에 운전이 없으면 병원을 고른 폰이 바로 맡는다', async () => {
    team('care', [{ role: 'care' }]);
    apply(
      T({
        status: 'requesting',
        confirmedHospital: null,
        requests: [
          {
            id: 11,
            hospitalId: 101,
            hospitalName: 'B병원',
            lat: 0,
            lng: 0,
            status: 'approved',
            closeReason: null,
            etaMin: 9,
            erBeds: null,
            memo: null,
            extraMemo: null,
            reason: null,
            reasonText: null,
            approvedAt: null,
            prevApprovedRecheck: false,
            version: 1,
          },
        ],
      }),
      'ios-me',
    );
    mockApi
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(T())
      .mockResolvedValue(undefined);
    await actions.confirm('101');
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('POST', '/transports/t-1/nav-device', expect.anything()),
    );
    actions.reset();
  });

  test('운전이 있는데 10초 안에 안 맡으면 고른 폰이 맡는다', async () => {
    jest.useFakeTimers();
    team('care', [{ role: 'driver' }]);
    apply(
      T({
        status: 'requesting',
        confirmedHospital: null,
        requests: [
          {
            id: 11,
            hospitalId: 101,
            hospitalName: 'B병원',
            lat: 0,
            lng: 0,
            status: 'approved',
            closeReason: null,
            etaMin: 9,
            erBeds: null,
            memo: null,
            extraMemo: null,
            reason: null,
            reasonText: null,
            approvedAt: null,
            prevApprovedRecheck: false,
            version: 1,
          },
        ],
      }),
      'ios-me',
    );
    mockApi.mockResolvedValue(T());
    await actions.confirm('101');
    expect(mockApi.mock.calls.some((c) => c[1] === '/transports/t-1/nav-device')).toBe(false);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_100);
    });
    expect(mockApi.mock.calls.some((c) => c[1] === '/transports/t-1/nav-device')).toBe(true);
    actions.reset();
    expect(getEngine().status).toBeNull();
  });
});
