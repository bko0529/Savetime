import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PendingScreen from '../../app/pending';
import SignupScreen from '../../app/signup';
import type { Me } from '../api/client';

const mockAuth = {
  state: { status: 'signedOut' } as { status: 'signedOut' } | { status: 'signedIn'; me: Me },
  signup: jest.fn(),
  refreshMe: jest.fn(),
  logout: jest.fn(),
};
jest.mock('../auth/AuthProvider', () => ({ useAuth: () => mockAuth }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));
const mockPick = jest.fn();
jest.mock('../auth/pickPhoto', () => ({ pickPhoto: (...a: unknown[]) => mockPick(...a) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.state = { status: 'signedOut' };
});

async function fillRequired() {
  await fireEvent.changeText(screen.getByLabelText('소속 소방서 코드'), 'cn-sb-019');
  await fireEvent.changeText(screen.getByLabelText('소속 안전센터'), '서북119안전센터');
  await fireEvent.changeText(screen.getByLabelText('이름'), '김도윤');
  await fireEvent.changeText(screen.getByLabelText('사번'), '2019-1234');
}

test('가입 신청: 모두 채우면 signup 을 부른다 (소방서 코드는 대문자)', async () => {
  mockPick.mockResolvedValue({
    photo: { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg', size: 10 },
  });
  mockAuth.signup.mockResolvedValue(null);
  await render(<SignupScreen />);
  await fillRequired();
  await fireEvent.changeText(screen.getByLabelText('아이디'), 'kimdoyun');
  await fireEvent.changeText(screen.getByLabelText('비밀번호'), 'abcd1234');
  await fireEvent.changeText(screen.getByLabelText('비밀번호 확인'), 'abcd1234');
  await fireEvent.press(screen.getByRole('button', { name: '앨범에서 선택' }));
  await waitFor(() => expect(screen.getByText('a.jpg')).toBeTruthy());
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByRole('button', { name: '가입 신청' }));
  await waitFor(() => expect(mockAuth.signup).toHaveBeenCalled());
  expect(mockAuth.signup.mock.calls[0][0]).toMatchObject({
    agencyCode: 'CN-SB-019',
    loginId: 'kimdoyun',
    photoConsent: true,
  });
});

test('빈 칸이 있으면 보내지 않고 문구를 보여 준다', async () => {
  await render(<SignupScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '가입 신청' }));
  expect(await screen.findByText('소속 소방서 코드를 적어 주세요')).toBeTruthy();
  expect(mockAuth.signup).not.toHaveBeenCalled();
});

test('반려 후 다시 신청: 아이디·비밀번호 칸이 없다', async () => {
  mockAuth.state = {
    status: 'signedIn',
    me: { id: 1, status: 'rejected', rejectReason: 'photo_unclear' },
  };
  await render(<SignupScreen />);
  expect(screen.queryByLabelText('아이디')).toBeNull();
  expect(screen.getByRole('button', { name: '다시 신청' })).toBeTruthy();
});

test('승인 대기: 결과 다시 확인 · 로그아웃', async () => {
  mockAuth.state = {
    status: 'signedIn',
    me: {
      id: 1,
      status: 'pending',
      name: '김도윤',
      rank: '소방교',
      agency: '서북소방서',
      safetyCenter: '서북119안전센터',
    },
  };
  await render(<PendingScreen />);
  expect(screen.getByText('승인 대기 중')).toBeTruthy();
  expect(screen.getByText('서북소방서 · 서북119안전센터')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '지금 결과 다시 확인' }));
  expect(mockAuth.refreshMe).toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: '로그아웃' }));
  expect(mockAuth.logout).toHaveBeenCalled();
});

test('반려: 사유 문구와 다시 가입 신청 버튼', async () => {
  mockAuth.state = {
    status: 'signedIn',
    me: { id: 1, status: 'rejected', rejectReason: 'photo_unclear' },
  };
  await render(<PendingScreen />);
  expect(screen.getByText('반려 사유: 공무원증 사진이 흐려서 확인할 수 없어요')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '다시 가입 신청' }));
  expect(mockPush).toHaveBeenCalledWith('/signup');
});
