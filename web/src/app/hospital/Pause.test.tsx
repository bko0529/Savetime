import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envelope, FakeSocket } from '@/testing/fakeSocket';
import { fakeServer, renderWithQuery } from '@/testing/render';
import { HospitalHome } from './HospitalHome';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/alarm/browserAlarm', () => ({
  unlockSound: vi.fn(async () => true),
  askNotificationPermission: vi.fn(async () => 'granted'),
  startAlarmLoop: vi.fn(),
  stopAlarmLoop: vi.fn(),
  showRequestNotification: vi.fn(),
  // 알림 권한 안내 띠(SFR-136, #49)가 이 함수로 권한을 읽는다
  notificationPermission: vi.fn(() => 'granted'),
}));

const SESSION = 'GET /hw/session';
const LIST = 'GET /hw/requests?status=open';
const PAUSE = 'PUT /hw/pause';
const PAUSED_AT = new Date(2026, 10, 4, 14, 5).toISOString();

function session(paused = false) {
  return {
    status: 200,
    body: {
      hospital: { id: 1, name: 'B병원' },
      pc: { id: 7, name: '접수대' },
      shift: { id: 5, staffName: '박서연', alarmOn: true },
      paused,
      pausedAt: paused ? PAUSED_AT : null,
    },
  };
}

function waiting(id: number) {
  return {
    id,
    label: `R-${id}`,
    status: 'waiting',
    chiefComplaint: '흉통',
    respondUntil: new Date(Date.now() + 90_000).toISOString(),
    etaMin: 9,
    etaSource: 'straight',
    abnormalCount: 0,
  };
}

function open(paused = false, items: object[] = []) {
  const socket = new FakeSocket();
  const server = fakeServer({
    [SESSION]: session(paused),
    [LIST]: { status: 200, body: { items, nextCursor: null, serverNow: new Date().toISOString() } },
    'GET /hw/incoming': { status: 200, body: { items: [] } },
    [PAUSE]: { status: 204 },
  });
  renderWithQuery(<HospitalHome createSocket={() => socket.asSocket()} />);
  return { socket, server };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('잠시 요청 중지 (SFR-139)', () => {
  it('대기 요청이 있으면 몇 건이 거절되는지 확인받고, 확인하면 중지를 보낸다', async () => {
    const { server } = open(false, [waiting(101), waiting(102)]);
    // 새 요청 창(덮개)을 먼저 확인한다. 실제 화면에서도 덮개가 다른 버튼을 가린다
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(await screen.findByRole('button', { name: '확인' }));
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '잠시 요청 중지' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        '응답 대기 2건이 거절(요청 중지)로 처리돼요. 이미 승인한 요청은 그대로예요.',
      ),
    ).toBeTruthy();

    server.set(SESSION, session(true));
    fireEvent.click(within(dialog).getByRole('button', { name: '요청 중지' }));
    await waitFor(() => expect(server.callsTo(PAUSE)).toHaveLength(1));
    expect(server.callsTo(PAUSE)[0].body).toEqual({ paused: true });

    // 상단에 '요청 중지 중'과 다시 받기 버튼
    expect(await screen.findByText('⏸ 요청 중지 중 (14:05부터)')).toBeTruthy();
    expect(screen.getByRole('button', { name: '요청 다시 받기' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('취소하면 보내지 않는다', async () => {
    const { server } = open();
    fireEvent.click(await screen.findByRole('button', { name: '잠시 요청 중지' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('응답 대기 중인 요청은 없어요.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.callsTo(PAUSE)).toHaveLength(0);
  });

  it('중지 중에 다시 받기를 누르면 풀린다', async () => {
    const { server } = open(true);
    const button = await screen.findByRole('button', { name: '요청 다시 받기' });
    server.set(SESSION, session(false));
    fireEvent.click(button);
    await waitFor(() => expect(server.callsTo(PAUSE)).toHaveLength(1));
    expect(server.callsTo(PAUSE)[0].body).toEqual({ paused: false });
    expect(await screen.findByRole('button', { name: '잠시 요청 중지' })).toBeTruthy();
    expect(screen.queryByText(/요청 중지 중/)).toBeNull();
  });

  it('다른 PC 가 중지하면(pause_changed) 이 PC 화면도 바뀐다', async () => {
    const { socket, server } = open();
    // 목록을 받으러 갔으면 실시간 연결이 화면에 넘어가 처리기도 붙은 뒤다
    await waitFor(() => expect(server.callsTo(LIST).length).toBeGreaterThan(0));
    server.set(SESSION, session(true));
    socket.fire(
      'hospital.pause_changed',
      envelope({ paused: true, byPcName: '처치실', byName: '김도윤', pausedAt: PAUSED_AT }),
    );
    expect(await screen.findByText('⏸ 요청 중지 중 (14:05부터)')).toBeTruthy();
  });

  it('중지 2시간째 알림이 오면 아직 멈춘 상태라고 알린다', async () => {
    const { socket, server } = open(true);
    await waitFor(() => expect(server.callsTo(LIST).length).toBeGreaterThan(0));
    socket.fire('hospital.pause_reminder', envelope({ pausedAt: PAUSED_AT }));
    expect(
      await screen.findByText('아직 요청을 멈춘 상태예요. 받을 수 있으면 다시 받아 주세요.'),
    ).toBeTruthy();
  });
});
