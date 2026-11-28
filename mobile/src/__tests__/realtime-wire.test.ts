import { addIncoming, refreshTeam, teamStore } from '../duty/team';
import { wireAccountAndTeam } from '../realtime/wire';
import { dispatch } from '../realtime/socket';

jest.mock('../duty/team', () => {
  const actual = jest.requireActual('../duty/team');
  return { ...actual, addIncoming: jest.fn(), refreshTeam: jest.fn() };
});
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

let seq = 100;
const env = (data: Record<string, unknown>) => ({
  seq: ++seq,
  room: 'paramedic:1',
  occurredAt: '',
  serverNow: new Date().toISOString(),
  data,
});

test('계정·팀 이벤트 → 할 일', () => {
  const refreshMe = jest.fn();
  const forceLogout = jest.fn();
  const off = wireAccountAndTeam({ refreshMe, forceLogout });

  dispatch('account.signup_result', env({ result: 'approved', reason: null }));
  expect(refreshMe).toHaveBeenCalled();

  const inv = {
    inviteId: 3,
    teamCode: '4821',
    fromName: '이구급',
    expiresAt: '2026-11-26T03:05:00Z',
  };
  dispatch('team.invited', env(inv));
  expect(addIncoming).toHaveBeenCalledWith(inv);

  dispatch('team.invite_result', env({ inviteId: 3, toName: '이구급', result: 'accepted' }));
  expect(teamStore.get().notice).toBe('이구급 님 초대: 수락했어요');
  expect(refreshTeam).toHaveBeenCalled();

  dispatch('account.force_logout', { ...env({ reason: 'suspended' }), seq: 0 });
  expect(forceLogout).toHaveBeenCalled();

  off();
  dispatch('account.signup_result', env({ result: 'approved', reason: null }));
  expect(refreshMe).toHaveBeenCalledTimes(1); // 끈 뒤에는 안 받음
});
