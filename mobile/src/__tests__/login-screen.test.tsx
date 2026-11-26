import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import LoginScreen from '../../app/login';

const mockLogin = jest.fn();
jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ state: { status: 'signedOut' }, login: mockLogin }),
}));

beforeEach(() => mockLogin.mockReset());

test('빈 칸이면 서버에 보내지 않고 안내를 보여 준다', async () => {
  await render(<LoginScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '로그인' }));
  expect(await screen.findByText('아이디를 입력해 주세요')).toBeTruthy();
  expect(mockLogin).not.toHaveBeenCalled();
});

test('서버가 준 오류 문구를 그대로 보여 준다', async () => {
  mockLogin.mockResolvedValueOnce('5번 틀려 10분 동안 잠겼어요');
  await render(<LoginScreen />);
  await fireEvent.changeText(screen.getByLabelText('아이디'), ' kim ');
  await fireEvent.changeText(screen.getByLabelText('비밀번호'), 'pw');
  await fireEvent.press(screen.getByRole('button', { name: '로그인' }));
  await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('kim', 'pw'));
  expect(await screen.findByText('5번 틀려 10분 동안 잠겼어요')).toBeTruthy();
});
