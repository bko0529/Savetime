import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import HomeScreen from '../../app/index';
import PatientScreen from '../../app/patient';
import RequestScreen from '../../app/request';
import { teamStore } from '../duty/team';
import { __resetEngineForTest, actions, apply, type ServerTransport } from '../transport/engine';
import { emptyPatient, REQUIRED_FIELDS } from '../transport/patient';
import { patientStore } from '../transport/patientStore';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  api: jest.fn(async () => ({ count: 5 })),
}));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'ios-me') }));
jest.mock('../transport/location', () => ({
  ...jest.requireActual('../transport/location'),
  currentLocation: jest.fn(async () => ({ lat: 36.8, lng: 127.1 })),
}));
jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    state: {
      status: 'signedIn',
      me: { id: 1, status: 'approved', name: '김도윤', rank: '소방교', safetyCenter: '서북센터' },
    },
    logout: jest.fn(),
  }),
}));
const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, navigate: jest.fn(), dismissTo: jest.fn() }),
  // 화면에 들어올 때 한 번 실행하는 것으로 흉내
  useFocusEffect: (fn: () => void) => require('react').useEffect(fn, []),
}));
jest.mock('../journal/storage', () => ({ listJournals: jest.fn(async () => []) }));

const base = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
  id: 't-1',
  status: 'requesting',
  version: 1,
  serverNow: '',
  requestRadiusKm: 20,
  fallbackRadiusKm: 30,
  fallbackReason: null,
  currentRound: { roundNo: 1, sentAt: new Date().toISOString(), respondUntil: '' },
  requests: [
    {
      id: 11,
      hospitalId: 101,
      hospitalName: '순천향대 천안병원',
      lat: 0,
      lng: 0,
      status: 'approved',
      closeReason: null,
      etaMin: 9,
      erBeds: '3/12',
      memo: '정문',
      extraMemo: null,
      reason: null,
      reasonText: null,
      approvedAt: new Date().toISOString(),
      prevApprovedRecheck: false,
      version: 1,
    },
    {
      id: 12,
      hospitalId: 102,
      hospitalName: '단국대병원',
      lat: 0,
      lng: 0,
      status: 'waiting',
      closeReason: null,
      etaMin: null,
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

beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  patientStore.reset();
  teamStore.reset();
  teamStore.set({
    team: {
      id: 1,
      code: '4821',
      members: [{ paramedicId: 1, name: '김도윤', role: 'care', isMe: true }],
    },
    started: true,
  });
});

test('홈: 새 이송 시작 → 칸을 비우고 환자 정보 입력으로', async () => {
  patientStore.set({ patient: { ...emptyPatient, complaint: '지난 환자' } });
  await render(<HomeScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '새 이송 시작' }));
  expect(patientStore.get().patient.complaint).toBe('');
  expect(mockPush).toHaveBeenCalledWith('/patient');
});

test('홈: 진행 중 이송이 있으면 이어서 보기만 보인다', async () => {
  apply(base(), 'ios-me');
  await render(<HomeScreen />);
  expect(screen.getByText('요청 중')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '새 이송 시작' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '진행 중 이송으로' }));
  expect(mockPush).toHaveBeenCalledWith('/request');
});

test('환자 정보: 필수 12개가 다 차야 요청할 수 있고, 확인 불가로 채울 수 있다', async () => {
  const create = jest.spyOn(actions, 'create').mockResolvedValue({ ok: true, value: undefined });
  await render(<PatientScreen />);
  const btn = () => screen.getByRole('button', { name: '병원에 요청' });
  expect(btn().props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByLabelText('직접 입력하세요'), '흉통');
  await fireEvent.press(screen.getByRole('button', { name: '3단계' }));
  await fireEvent.press(screen.getByRole('button', { name: '나머지 확인 불가로 보내기' }));
  expect(REQUIRED_FIELDS.every((k) => String(patientStore.get().patient[k]).trim() !== '')).toBe(
    true,
  );
  expect(screen.getByText('필수 12개 모두 입력됨')).toBeTruthy();
  await fireEvent.press(btn());
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0]![1]).toMatchObject({ complaint: '흉통', sex: '확인 불가' });
});

test('요청 화면: 승인 칸 · 남은 시간 · 대기 병원', async () => {
  apply(base(), 'ios-me');
  await render(<RequestScreen />);
  expect(screen.getByText('승인 1곳')).toBeTruthy();
  expect(screen.getByText('순천향대 천안병원')).toBeTruthy();
  expect(screen.getByText('"정문"')).toBeTruthy();
  expect(screen.getByText('대기 1 · 거절 0')).toBeTruthy();
});

test('요청 화면: 상세에서 확정 → 한 번 더 묻고 확정', async () => {
  apply(base(), 'ios-me');
  const confirm = jest.spyOn(actions, 'confirm').mockResolvedValue({ ok: true, value: undefined });
  const alert = jest.spyOn(Alert, 'alert');
  await render(<RequestScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '순천향대 천안병원 승인 · 자세히' }));
  await fireEvent.press(screen.getByRole('button', { name: '이 병원으로 확정' }));
  expect(alert.mock.calls[0]![0]).toBe('순천향대 천안병원으로 확정할까요?');
  const ok = alert.mock.calls[0]![2]!.find((b) => b.text === '확정')!;
  ok.onPress!();
  expect(confirm).toHaveBeenCalledWith('101');
});

test('예비 추천: 다음 반경으로 넓혀 다시 요청', async () => {
  apply(
    base({
      status: 'fallback',
      fallbackReason: 'all_rejected',
      fallbackRadiusKm: 20,
      requests: [],
    }),
    'ios-me',
  );
  const expand = jest.spyOn(actions, 'expand').mockResolvedValue({ ok: true, value: undefined });
  await render(<RequestScreen />);
  expect(screen.getByText('모든 병원이 거절했어요 · 가까운 병원에 전화로 확인하세요')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '반경 넓혀 다시 요청 (30km)' }));
  expect(expand).toHaveBeenCalled();
});
