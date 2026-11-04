import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as alarm from '@/lib/alarm/browserAlarm';
import { envelope, FakeSocket } from '@/testing/fakeSocket';
import { fakeServer, renderWithQuery } from '@/testing/render';
import { HospitalHome } from './HospitalHome';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
// 소리·브라우저 알림은 jsdom 에 없으니 불렸는지만 본다
vi.mock('@/lib/alarm/browserAlarm', () => ({
  unlockSound: vi.fn(async () => true),
  askNotificationPermission: vi.fn(async () => 'granted'),
  startAlarmLoop: vi.fn(),
  stopAlarmLoop: vi.fn(),
  showRequestNotification: vi.fn(),
}));

const HOSPITAL = { hospital: { id: 1, name: 'A병원' }, pc: { id: 7, name: '접수대' } };
const SHIFT = { id: 5, staffName: '김간호', alarmOn: true };
const LIST = 'GET /hw/requests?status=open';

const now = Date.now();
function item(id: number, respondInSec: number, status = 'waiting') {
  return {
    id,
    label: `R-${id}`,
    status,
    chiefComplaint: id === 101 ? '흉통' : '호흡곤란',
    etaMin: 8,
    respondUntil: new Date(now + respondInSec * 1000).toISOString(),
    version: 1,
  };
}
function list(...items: ReturnType<typeof item>[]) {
  return { status: 200, body: { items, nextCursor: null, serverNow: new Date().toISOString() } };
}

let socket: FakeSocket;
let server: ReturnType<typeof fakeServer>;

beforeEach(async () => {
  vi.clearAllMocks();
  document.title = '세이브타임';
  socket = new FakeSocket();
  server = fakeServer({
    'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
    'POST /hw/shifts/current/alarm-on': { status: 200, body: { shiftId: 9 } },
    [LIST]: list(),
  });
  renderWithQuery(<HospitalHome createSocket={() => socket.asSocket()} />);
  await screen.findByText('알림 켜기를 다시 누르세요.');
  socket.serverConnect();
  fireEvent.click(screen.getByRole('button', { name: '알림 켜기' }));
  await screen.findByText(/알림 켜짐/);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 서버가 request.new 를 보냈을 때. ack 함수를 돌려줘서 바로 불렸는지 볼 수 있게 한다
function newRequest(id: number) {
  const ack = vi.fn();
  socket.fire(
    'request.new',
    envelope({ requestId: id, label: '새 이송 요청', respondUntil: new Date().toISOString() }),
    ack,
  );
  return ack;
}

describe('새 요청 받기 (SFR-117·135·161)', () => {
  it('받자마자 ack 를 보내고, 목록을 다시 받아 덮개 창·소리·탭 제목·브라우저 알림을 띄운다', async () => {
    server.set(LIST, list(item(101, 110)));
    const before = server.callsTo(LIST).length;
    const ack = newRequest(101);

    // 목록을 받기 전에 이미 ack 를 보냈어야 한다
    expect(ack).toHaveBeenCalledWith({ received: true });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('R-101');
    expect(dialog.textContent).toContain('흉통');
    expect(server.callsTo(LIST).length).toBeGreaterThan(before);
    expect(screen.getByText('🔴 새 이송 요청 1건')).toBeDefined();
    expect(document.title).toBe('🔴 새 이송 요청 1건');
    expect(alarm.startAlarmLoop).toHaveBeenCalledTimes(1);
    expect(alarm.showRequestNotification).toHaveBeenCalledWith(101, 'R-101');
  });

  it('여러 건이 와도 소리는 하나만, 브라우저 알림은 요청마다 1번, 창은 마감이 빠른 것부터', async () => {
    server.set(LIST, list(item(101, 110)));
    newRequest(101);
    await screen.findByRole('dialog');

    server.set(LIST, list(item(101, 110), item(102, 60)));
    newRequest(102);
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('대기 2건'));

    expect(screen.getByRole('dialog').textContent).toContain('R-102');
    expect(alarm.startAlarmLoop).toHaveBeenCalledTimes(1);
    expect(alarm.showRequestNotification).toHaveBeenCalledTimes(2);
    expect(document.title).toBe('🔴 새 이송 요청 2건');
  });

  it("'확인'을 누르면 다음 요청 창으로, 다 확인해도 응답 전까지 소리·건수는 남는다", async () => {
    server.set(LIST, list(item(101, 110), item(102, 60)));
    newRequest(102);
    await screen.findByRole('dialog');
    // 처음 화면(대기 0건)에서 '멈춤'이 한 번 불린 건 빼고 센다
    const stopsBefore = vi.mocked(alarm.stopAlarmLoop).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('R-101'));

    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(alarm.stopAlarmLoop).toHaveBeenCalledTimes(stopsBefore);
    expect(screen.getByText('🔴 새 이송 요청 2건')).toBeDefined();
  });

  it('다른 PC 응답·만료로 요청이 끝나면(request.changed) 창·소리·제목이 멈춘다', async () => {
    server.set(LIST, list(item(101, 110)));
    newRequest(101);
    await screen.findByRole('dialog');

    server.set(LIST, list(item(101, 110, 'approved')));
    socket.fire(
      'request.changed',
      envelope({
        requestId: 101,
        status: 'approved',
        closeReason: null,
        byName: null,
        pcName: '처치실',
      }),
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(alarm.stopAlarmLoop).toHaveBeenCalled();
    expect(screen.queryByText(/새 이송 요청 \d+건/)).toBeNull();
    expect(document.title).toBe('세이브타임');
  });

  it('다시 연결되면 목록을 새로 받는다 (놓친 요청 대비)', async () => {
    const before = server.callsTo(LIST).length;
    socket.serverDisconnect();
    socket.serverConnect('sock-2');
    await waitFor(() => expect(server.callsTo(LIST).length).toBeGreaterThan(before));
  });
});

describe('남은 시간은 서버 시각 기준', () => {
  it('PC 시계가 10분 늦어도 서버 기준으로 남은 시간을 보여준다', async () => {
    const serverNow = Date.now() + 10 * 60 * 1000;
    server.set(LIST, {
      status: 200,
      body: {
        items: [{ ...item(101, 0), respondUntil: new Date(serverNow + 90_000).toISOString() }],
        nextCursor: null,
        serverNow: new Date(serverNow).toISOString(),
      },
    });
    newRequest(101);
    const dialog = await screen.findByRole('dialog');
    // PC 시계로 계산했다면 11분 넘게 남았다고 나온다
    expect(dialog.textContent).toMatch(/응답 남은 시간 1분 (2\d|30)초/);
  });
});
