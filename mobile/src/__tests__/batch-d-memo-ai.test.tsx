import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import DutyScreen from '../../app/duty';
import LogScreen from '../../app/log';
import { ApiError, api } from '../api/client';
import { teamStore } from '../duty/team';
import { organize } from '../journal/ai';
import { configStore } from '../state/config';
import { __resetEngineForTest } from '../transport/engine';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), api: jest.fn() }));
jest.mock('../journal/storage', () => ({
  saveJournal: jest.fn(),
  getJournal: jest.fn(async () => null),
}));
jest.mock('../transport/engine', () => ({
  ...jest.requireActual('../transport/engine'),
  loadJournalDraft: jest.fn(async () => null),
}));
jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    state: {
      status: 'signedIn',
      me: { id: 1, status: 'approved', name: '김구조', rank: '소방교' },
    },
    logout: jest.fn(),
  }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), dismissTo: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
const mockApi = jest.mocked(api);

beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  configStore.reset();
  teamStore.reset();
});

test('대원 메모: 이름 아래에 작게, 나만 보기, 20자 (SFR-143)', async () => {
  teamStore.set({
    team: {
      id: 1,
      code: '4821',
      qrToken: 'q',
      members: [{ paramedicId: 1, name: '김구조', role: 'care', isMe: true }],
    },
    isCreator: true,
  });
  mockApi.mockImplementation(async (m: string, path: string) =>
    path.startsWith('/paramedics/on-duty')
      ? {
          items: [
            {
              paramedicId: 7,
              name: '이하준',
              rank: '소방사',
              safetyCenter: '3센터',
              employeeNoTail: '0007',
              myMemo: null,
              onDuty: true,
              inTeam: false,
              inviteStatus: 'none',
            },
          ],
        }
      : undefined,
  );
  await render(<DutyScreen />);
  await fireEvent.press(
    await screen.findByRole('button', { name: '이하준 메모 쓰기' }, { timeout: 2000 }),
  );
  await fireEvent.changeText(
    screen.getByLabelText('대원 메모'),
    '3센터 운전 담당이고 친절하고 경력 많음',
  );
  await fireEvent.press(screen.getByRole('button', { name: '메모 저장' }));
  await waitFor(() =>
    expect(mockApi).toHaveBeenCalledWith('PUT', '/memos/7', {
      body: { memo: '3센터 운전 담당이고 친절하고 경력' },
    }),
  );
  expect(await screen.findByText('메모 · 3센터 운전 담당이고 친절하고 경력')).toBeTruthy();
});

test('AI 정리: 제안을 받아 하나씩 적용 (SFR-167)', async () => {
  configStore.set({ featureFlags: { journalAi: true, hospitalGrade: false } });
  mockApi.mockResolvedValue({
    suggestions: { chiefComplaint: '흉통 30분', treatment: '산소 4L', history: null },
    removedIdentifiers: 1,
  });
  await render(<LogScreen />);
  await fireEvent.changeText(
    await screen.findByLabelText('AI 정리 메모'),
    '홍길동 환자 흉통 30분 산소 4L',
  );
  await fireEvent.changeText(screen.getByLabelText('PDF에만 넣는 환자 성명'), '홍길동');
  await fireEvent.press(screen.getByRole('button', { name: 'AI로 정리' }));
  await waitFor(() =>
    expect(mockApi).toHaveBeenCalledWith('POST', '/journal/ai-organize', {
      body: { text: '홍길동 환자 흉통 30분 산소 4L', names: ['홍길동'] },
      timeoutMs: 15000,
    }),
  );
  await fireEvent.press(await screen.findByRole('button', { name: '주 호소 적용' }));
  await fireEvent.press(screen.getByRole('button', { name: '처치 적용' }));
  expect(screen.getAllByText('흉통 30분').length).toBeGreaterThan(1); // 제안 + 일지 주 호소 칸
  expect(screen.getByText('처치: 산소 4L')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '병력 적용' })).toBeNull(); // 빈 제안은 안 보임
});

test('AI 기능이 꺼져 있으면 안 보이고, 못 쓰면 문구', async () => {
  await render(<LogScreen />);
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(screen.queryByText('AI로 일지 정리 (제안)')).toBeNull();
  mockApi.mockRejectedValueOnce(new ApiError(503, 'AI_UNAVAILABLE', 'x'));
  expect(await organize('메모', [])).toBe('AI 정리를 지금 쓸 수 없어요. 직접 적어 주세요');
  expect(await organize('  ', [])).toBe('정리할 메모를 적어 주세요');
});
