import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import DutyScreen from '../../app/duty';
import InviteScreen from '../../app/invite';
import { teamStore } from '../duty/team';

const mockTeam = {
  createTeam: jest.fn(async () => null),
  joinTeam: jest.fn(async () => null),
  startDuty: jest.fn(async () => undefined),
  setMyRole: jest.fn(async () => null),
  listColleagues: jest.fn(async () => []),
  sendInvite: jest.fn(async () => null),
  acceptInvite: jest.fn(async () => null),
  declineInvite: jest.fn(async () => undefined),
};
jest.mock('../duty/team', () => {
  const actual = jest.requireActual('../duty/team');
  return {
    ...actual,
    createTeam: (...a: unknown[]) => (mockTeam.createTeam as jest.Mock)(...a),
    joinTeam: (...a: unknown[]) => (mockTeam.joinTeam as jest.Mock)(...a),
    startDuty: (...a: unknown[]) => (mockTeam.startDuty as jest.Mock)(...a),
    setMyRole: (...a: unknown[]) => (mockTeam.setMyRole as jest.Mock)(...a),
    listColleagues: (...a: unknown[]) => (mockTeam.listColleagues as jest.Mock)(...a),
    sendInvite: (...a: unknown[]) => (mockTeam.sendInvite as jest.Mock)(...a),
    acceptInvite: (...a: unknown[]) => (mockTeam.acceptInvite as jest.Mock)(...a),
    declineInvite: (...a: unknown[]) => (mockTeam.declineInvite as jest.Mock)(...a),
  };
});
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    state: {
      status: 'signedIn',
      me: {
        id: 1,
        status: 'approved',
        name: '김도윤',
        rank: '소방교',
        agency: '서북소방서',
        safetyCenter: '서북119안전센터',
      },
    },
    logout: jest.fn(),
  }),
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), canGoBack: () => true, replace: jest.fn() }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  teamStore.reset();
  teamStore.set({ team: null });
});

test('팀 없이 근무 시작: 팀을 만들고 시작한다', async () => {
  await render(<DutyScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '팀 만들고 근무 시작' }));
  await waitFor(() => expect(mockTeam.startDuty).toHaveBeenCalled());
  expect(mockTeam.createTeam).toHaveBeenCalledWith('처치');
});

test('팀이 있으면 코드와 팀원이 보인다', async () => {
  teamStore.set({
    team: {
      id: 1,
      code: '4821',
      qrToken: 'qr',
      members: [
        { paramedicId: 1, name: '김도윤', rank: '소방교', role: 'care', isMe: true },
        { paramedicId: 2, name: '이구급', rank: '소방사', role: 'driver', isMe: false },
      ],
    },
    isCreator: true,
  });
  await render(<DutyScreen />);
  expect(screen.getByLabelText('팀 코드 4821')).toBeTruthy();
  expect(screen.getByText('이구급')).toBeTruthy();
  expect(screen.getByText('오늘의 팀 (2명)')).toBeTruthy();
  // 운전이 이미 있으니 내 '운전' 은 못 고른다
  expect(screen.getByRole('tab', { name: '운전' }).props.accessibilityState.disabled).toBe(true);
});

test('팀 참여: 4자리가 아니면 보내지 않는다, 4자리면 참여', async () => {
  await render(<DutyScreen />);
  await fireEvent.press(screen.getByRole('tab', { name: '팀 참여' }));
  await fireEvent.changeText(screen.getByLabelText('팀 코드'), '48');
  await fireEvent.press(screen.getByRole('button', { name: '참여' }));
  expect(await screen.findByText('팀원 화면의 4자리 코드를 입력해 주세요')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('팀 코드'), '4821');
  await fireEvent.press(screen.getByRole('button', { name: '참여' }));
  await waitFor(() => expect(mockTeam.joinTeam).toHaveBeenCalledWith({ code: '4821' }, '처치'));
});

test('받은 초대가 있으면 배너 → 초대 화면에서 수락', async () => {
  const inv = {
    inviteId: 5,
    teamCode: '1234',
    fromName: '박구조',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  teamStore.set({ incoming: [inv] });
  await render(<DutyScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '받은 팀 초대 보기' }));
  expect(mockPush).toHaveBeenCalledWith('/invite');

  await render(<InviteScreen />);
  expect(screen.getByText('박구조')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '수락' }));
  await waitFor(() => expect(mockTeam.acceptInvite).toHaveBeenCalledWith(inv, '처치'));
});
