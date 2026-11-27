import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import LogScreen from '../../app/log';
import { __resetEngineForTest } from '../transport/engine';
import { emptyPatient } from '../transport/patient';
import { patientStore } from '../transport/patientStore';

const mockDraft = {
  hospitalName: '순천향대 천안병원',
  distanceKm: 6.4,
  crew: [{ name: '이구급', rank: '소방사', role: 'driver' }],
  vitals: {},
  chiefComplaint: '흉통',
  sex: 'M',
};
jest.mock('../transport/engine', () => ({
  ...jest.requireActual('../transport/engine'),
  loadJournalDraft: jest.fn(async () => mockDraft),
}));
const mockSave = jest.fn(async () => undefined);
jest.mock('../journal/storage', () => ({
  saveJournal: (...a: unknown[]) => (mockSave as jest.Mock)(...a),
  getJournal: jest.fn(async () => null),
}));
const mockShare = jest.fn(async () => undefined);
jest.mock('../journal/exportPdf', () => ({
  sharePdf: (...a: unknown[]) => (mockShare as jest.Mock)(...a),
  printSheet: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    state: {
      status: 'signedIn',
      me: { id: 1, status: 'approved', name: '김구조', rank: '소방교' },
    },
  }),
}));
const mockDismiss = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: mockDismiss, push: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

beforeEach(() => {
  jest.clearAllMocks();
  __resetEngineForTest();
  patientStore.set({ patient: { ...emptyPatient, pulse: '110' } });
});

test('서버 초안과 이 폰 입력으로 칸이 자동으로 채워진다', async () => {
  await render(<LogScreen />);
  expect(await screen.findByText('순천향대 천안병원')).toBeTruthy();
  expect(screen.getByText('6.4km')).toBeTruthy();
  expect(screen.getAllByText('흉통')).toHaveLength(2); // 증상 칸 + 주 호소 칸
  expect(screen.getByText(/맥박 110/)).toBeTruthy();
});

test('수정 → 값 바꾸기 → 저장하면 이 폰에 보관하고 홈으로', async () => {
  await render(<LogScreen />);
  await screen.findByText('순천향대 천안병원');
  await fireEvent.press(screen.getByRole('button', { name: '응급처치 수정' }));
  await fireEvent.press(screen.getByRole('checkbox', { name: '산소투여' }));
  await fireEvent.press(screen.getByRole('button', { name: '응급처치 완료' }));
  expect(screen.getByText('산소투여')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '저장하고 홈으로' }));
  await waitFor(() => expect(mockSave).toHaveBeenCalled());
  const saved = (mockSave.mock.calls[0] as unknown[])[1] as { care: string[] };
  expect(saved.care).toEqual(['산소투여']);
  expect(mockDismiss).toHaveBeenCalledWith('/');
  expect(patientStore.get().patient).toEqual(emptyPatient); // 다음 이송을 위해 비움
});

test('환자 성명은 PDF 에만 들어가고 저장 데이터에는 없다 (SER-012)', async () => {
  await render(<LogScreen />);
  await screen.findByText('순천향대 천안병원');
  await fireEvent.changeText(screen.getByLabelText('PDF에만 넣는 환자 성명'), '홍길동');
  await fireEvent.press(screen.getByRole('button', { name: 'PDF 공유' }));
  await waitFor(() => expect(mockShare).toHaveBeenCalled());
  expect((mockShare.mock.calls[0] as unknown[])[1]).toBe('홍길동');
  await fireEvent.press(screen.getByRole('button', { name: '저장하고 홈으로' }));
  await waitFor(() => expect(mockSave).toHaveBeenCalled());
  expect(JSON.stringify(mockSave.mock.calls[0])).not.toContain('홍길동');
});
