/**
 * Lovable 디자인 맞추기: 팀 초대 알림 카드 · 드롭다운 · 입력칸 모양 선택
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Vibration } from 'react-native';
import { BANNER_MS, InvitePush } from '../duty/InvitePush';
import { addIncoming, teamStore } from '../duty/team';
import { FieldChoice, Select } from '../ui/kit';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const inv = (id: number) => ({
  inviteId: id,
  teamCode: '4821',
  fromName: '이보준',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
});

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
  teamStore.set({ incoming: [] });
  jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
});
afterEach(() => jest.useRealTimers());

describe('팀 초대 알림 카드', () => {
  test('초대가 오면 카드가 뜨고 진동, 누르면 초대 화면으로', async () => {
    await render(<InvitePush canOpen />);
    await act(async () => addIncoming(inv(1)));
    expect(screen.getByText('이보준 대원이 팀 4821에 초대했어요')).toBeTruthy();
    expect(Vibration.vibrate).toHaveBeenCalled();
    await fireEvent.press(
      screen.getByRole('button', { name: '이보준 대원이 팀 4821에 초대했어요' }),
    );
    expect(mockPush).toHaveBeenCalledWith('/invite');
    expect(screen.queryByText('이보준 대원이 팀 4821에 초대했어요')).toBeNull();
  });

  test('6초 뒤 저절로 숨고, 같은 초대는 다시 띄우지 않는다', async () => {
    await render(<InvitePush canOpen />);
    await act(async () => addIncoming(inv(2)));
    await act(async () => jest.advanceTimersByTime(BANNER_MS));
    expect(screen.queryByText('이보준 대원이 팀 4821에 초대했어요')).toBeNull();
    await act(async () => teamStore.set({ incoming: [...teamStore.get().incoming] }));
    expect(screen.queryByText('이보준 대원이 팀 4821에 초대했어요')).toBeNull();
  });

  test('근무 중이면 수락할 수 없다고 알리고 화면을 옮기지 않는다', async () => {
    await render(<InvitePush canOpen={false} />);
    await act(async () => addIncoming(inv(3)));
    expect(screen.getByText('이미 근무 중이라 수락할 수 없어요')).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: '이보준 대원이 팀 4821에 초대했어요' }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('닫기 버튼', async () => {
    await render(<InvitePush canOpen />);
    await act(async () => addIncoming(inv(4)));
    await fireEvent.press(screen.getByRole('button', { name: '알림 닫기' }));
    expect(screen.queryByText('이보준 대원이 팀 4821에 초대했어요')).toBeNull();
  });
});

describe('드롭다운 · 입력칸 모양 선택', () => {
  test('드롭다운: 누르면 목록, 고르면 값이 바뀐다', async () => {
    const onChange = jest.fn();
    await render(<Select label="나이대" value="" options={['20대', '30대']} onChange={onChange} />);
    await fireEvent.press(screen.getByRole('button', { name: '나이대 선택' }));
    await fireEvent.press(screen.getByRole('radio', { name: '30대' }));
    expect(onChange).toHaveBeenCalledWith('30대');
  });

  test('성별: 고른 칸이 선택 상태', async () => {
    const onChange = jest.fn();
    await render(<FieldChoice value="여" options={['남', '여'] as const} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: '여' }).props.accessibilityState).toMatchObject({
      selected: true,
    });
    await fireEvent.press(screen.getByRole('radio', { name: '남' }));
    expect(onChange).toHaveBeenCalledWith('남');
  });
});
