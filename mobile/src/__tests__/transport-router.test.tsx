/**
 * 실제로 있었던 버그: 환자 정보 입력에서 '병원에 요청'을 누르면 요청 화면이 열렸다가
 * 입력 화면의 되돌아가기 때문에 바로 닫혀, 입력 화면에 머물렀다.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PatientScreen from '../../app/patient';
import {
  __resetEngineForTest,
  __setLoadedForTest,
  actions,
  apply,
  type ServerTransport,
} from '../transport/engine';
import { emptyPatient, REQUIRED_FIELDS, UNKNOWN } from '../transport/patient';
import { patientStore } from '../transport/patientStore';
import { TransportRouter } from '../transport/ui/TransportRouter';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  api: jest.fn(async () => ({ count: 3 })),
}));
jest.mock('../auth/storage', () => ({ getDeviceId: jest.fn(async () => 'ios-me') }));
let mockPath = '/patient';
const mockRouter = {
  back: jest.fn(),
  replace: jest.fn(),
  navigate: jest.fn(),
  push: jest.fn(),
  dismissTo: jest.fn(),
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, usePathname: () => mockPath }));

const T = (patch: Partial<ServerTransport> = {}): ServerTransport => ({
  id: 't-1',
  status: 'fallback',
  version: 1,
  serverNow: '',
  requestRadiusKm: 20,
  fallbackRadiusKm: 20,
  fallbackReason: 'no_target',
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

beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  mockPath = '/patient';
  const full = { ...emptyPatient };
  REQUIRED_FIELDS.forEach((k) => ((full[k] as string) = UNKNOWN));
  patientStore.set({ patient: full });
  __setLoadedForTest(); // 앱을 켜고 서버를 이미 읽은 상태
});

test('입력 화면에서 요청하면 요청 화면으로 바꿔 열고, 되돌아가기는 하지 않는다', async () => {
  jest.spyOn(actions, 'create').mockImplementation(async () => {
    apply(T(), 'ios-me'); // 서버가 이송 건을 만들어 상태가 바뀜
    return { ok: true, value: undefined };
  });
  await render(
    <>
      <TransportRouter />
      <PatientScreen />
    </>,
  );
  await fireEvent.press(screen.getByRole('button', { name: '병원에 요청' }));
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/request'));
  expect(mockRouter.back).not.toHaveBeenCalled();
});

test('다른 화면에서는 이송 상태가 바뀌면 그 화면으로 이동 (팀원 폰에서 바꿔도)', async () => {
  mockPath = '/';
  await render(<TransportRouter />);
  await act(async () => apply(T({ status: 'requesting' }), 'ios-me'));
  await waitFor(() => expect(mockRouter.navigate).toHaveBeenCalledWith('/request'));
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test('변경 사항 보내기(진행 중 이송)는 보낸 뒤 이전 화면으로 돌아간다', async () => {
  apply(T(), 'ios-me');
  jest.spyOn(actions, 'updateAssessment').mockResolvedValue({ ok: true, value: undefined });
  await render(<PatientScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '변경 사항 보내기' }));
  await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
});

/**
 * 실제로 있었던 버그 (2026-11-28): 요청 → 취소 → 홈의 '새 이송 시작' → 다시 요청하면
 * 요청 화면으로 안 넘어가고 입력 화면이 '변경 사항 보내기'로 바뀌어 남았다.
 * 화면을 비우는 reset() 이 '서버를 읽었음(loaded)'까지 지워 화면 이동이 멈췄기 때문
 */
test('취소 뒤 새 이송을 시작해 다시 요청해도 요청 화면으로 넘어간다', async () => {
  await render(<TransportRouter />);
  await act(async () => apply(T({ id: 't-old' }), 'ios-me'));
  await act(async () => apply(T({ id: 't-old', status: 'cancelled', version: 2 }), 'ios-me'));
  expect(mockRouter.dismissTo).toHaveBeenCalledWith('/');
  jest.clearAllMocks();

  // 홈의 '새 이송 시작' = 화면 비우기
  await act(async () => actions.reset());
  mockPath = '/patient';
  await act(async () => apply(T({ id: 't-new' }), 'ios-me'));
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/request'));
});
