import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope, FakeSocket } from '@/testing/fakeSocket';
import { fakeServer, renderWithQuery } from '@/testing/render';
import { HospitalHome } from './HospitalHome';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/alarm/browserAlarm', () => ({
  unlockSound: vi.fn(async () => true),
  askNotificationPermission: vi.fn(async () => 'granted'),
  notificationPermission: vi.fn(() => 'granted'),
  startAlarmLoop: vi.fn(),
  stopAlarmLoop: vi.fn(),
  showRequestNotification: vi.fn(),
}));

const INCOMING = 'GET /hw/incoming';
const SESSION = {
  hospital: { id: 1, name: 'B병원' },
  pc: { id: 7, name: '접수대' },
  shift: { id: 5, staffName: '박서연', alarmOn: true },
};

function incoming(id: number, extra: object = {}) {
  return {
    id,
    label: `R-${id}`,
    summary: '남·60대 · 뇌출혈 의심',
    status: 'confirmed',
    version: 1,
    etaMin: 7,
    hasLocation: true,
    changedFields: [],
    arrivedAt: null,
    canConfirmArrival: false,
    canMarkUnacceptable: false,
    extraMemoUsed: false,
    ...extra,
  };
}
const list = (...items: object[]) => ({
  status: 200,
  body: { items, serverNow: new Date().toISOString() },
});

let socket: FakeSocket;
let server: ReturnType<typeof fakeServer>;

beforeEach(() => {
  socket = new FakeSocket();
  server = fakeServer({
    'GET /hw/session': { status: 200, body: SESSION },
    'GET /hw/requests?status=open': { status: 200, body: { items: [], nextCursor: null } },
    [INCOMING]: list(incoming(102)),
  });
  renderWithQuery(<HospitalHome createSocket={() => socket.asSocket()} />);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// '도착 예정' 제목 아래 표
async function incomingTable() {
  const heading = await screen.findByRole('heading', { name: '도착 예정' });
  return heading.parentElement!;
}

describe('도착 예정 목록 (SFR-121)', () => {
  it("근무 중이면 화면 제목이 '근무 시작'이 아니라 '이송 요청'", async () => {
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('이송 요청');
  });

  it("우리 병원으로 확정된 환자를 '요약 · 이동 중 · 도착 예상 N분'으로 보여 준다", async () => {
    const section = await incomingTable();
    const row = (await within(section).findByText('R-102')).closest('tr')!;
    expect(row.textContent).toContain('남·60대 · 뇌출혈 의심');
    expect(row.textContent).toContain('이동 중');
    expect(row.textContent).toContain('도착 예상 7분');
  });

  it('구급차 위치·지도는 보여 주지 않는다 (D-71)', async () => {
    await screen.findByText('도착 예상 7분');
    expect(document.body.textContent).not.toMatch(/위도|경도|지도|km/);
    expect(document.querySelector('iframe, canvas, [data-map]')).toBeNull();
  });

  it('새로 확정·도착 예상 갱신·도착 알림이 오면 목록을 다시 받는다', async () => {
    await screen.findByText('도착 예상 7분');
    const before = server.callsTo(INCOMING).length;

    server.set(INCOMING, list(incoming(102, { etaMin: 3 })));
    socket.fire('incoming.updated', envelope({ requestId: 102, etaMin: 3 }));
    expect(await screen.findByText('도착 예상 3분')).toBeTruthy();

    server.set(INCOMING, list(incoming(102, { etaMin: 3 }), incoming(103, { etaMin: 15 })));
    socket.fire(
      'incoming.added',
      envelope({ requestId: 103, label: 'R-103', etaMin: 15, hasLocation: true }),
    );
    expect(await screen.findByText('도착 예상 15분')).toBeTruthy();

    const arrivedAt = new Date(2026, 10, 3, 14, 5).toISOString();
    server.set(INCOMING, list(incoming(102, { status: 'arrived', arrivedAt, etaMin: null })));
    socket.fire('incoming.arrived', envelope({ requestId: 102, arrivedAt, method: 'button' }));
    expect(await screen.findByText('14:05 도착')).toBeTruthy();
    expect(server.callsTo(INCOMING).length).toBe(before + 3);
  });

  it('이송이 취소되면 목록에서 빠지고, 확인을 누를 때까지 이유를 보여 준다', async () => {
    await screen.findByText('도착 예상 7분');
    server.set(INCOMING, list());
    socket.fire('incoming.removed', envelope({ requestId: 102, reason: 'cancelled' }));

    const notice = await screen.findByText('R-102 이송이 취소됐어요');
    await waitFor(() => expect(screen.queryByText('도착 예상 7분')).toBeNull());
    expect(screen.getByText('도착 예정 환자가 없어요.')).toBeTruthy();

    fireEvent.click(
      within(notice.closest('[role=alert]')! as HTMLElement).getByRole('button', { name: '확인' }),
    );
    expect(screen.queryByText('R-102 이송이 취소됐어요')).toBeNull();
  });

  it('목적지가 바뀌거나 승인을 취소해도 이유를 보여 준다', async () => {
    await screen.findByText('도착 예상 7분');
    server.set(INCOMING, list());
    socket.fire('incoming.removed', envelope({ requestId: 102, reason: 'dest_changed' }));
    expect(await screen.findByText('R-102 목적지가 다른 병원으로 바뀌었어요')).toBeTruthy();
    socket.fire('incoming.removed', envelope({ requestId: 104, reason: 'approval_cancelled' }));
    expect(await screen.findByText('R-104 승인을 취소해서 도착 예정에서 빠졌어요')).toBeTruthy();
  });

  it('다시 연결되면 전체를 다시 받는다', async () => {
    await screen.findByText('도착 예상 7분');
    const before = server.callsTo(INCOMING).length;
    socket.serverConnect('sock-2');
    await waitFor(() => expect(server.callsTo(INCOMING).length).toBeGreaterThan(before));
  });
});

describe('도착 예정 목록의 추가 메모 (SFR-140)', () => {
  const EXTRA = 'POST /hw/requests/102/extra-memo';

  it("이동 중 환자에 '추가 메모'를 보내면 목록을 다시 받고 버튼이 사라진다", async () => {
    server.set(EXTRA, { status: 204 });
    const section = await incomingTable();
    const row = (await within(section).findByText('R-102')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: '추가 메모' }));
    const dialog = await screen.findByRole('dialog');

    server.set(INCOMING, list(incoming(102, { extraMemoUsed: true, version: 2 })));
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'CT 고장, 2번 입구로 오세요' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '추가 메모 보내기' }));

    await waitFor(() => expect(server.callsTo(EXTRA)).toHaveLength(1));
    expect(server.callsTo(EXTRA)[0].body).toEqual({
      memo: 'CT 고장, 2번 입구로 오세요',
      version: 1,
    });
    await waitFor(() =>
      expect(within(section).queryByRole('button', { name: '추가 메모' })).toBeNull(),
    );
  });

  it('이미 보냈거나 도착한 환자에는 버튼이 없다', async () => {
    server.set(
      INCOMING,
      list(
        incoming(102, { extraMemoUsed: true }),
        incoming(103, { status: 'arrived', arrivedAt: new Date().toISOString(), etaMin: null }),
      ),
    );
    socket.fire('incoming.updated', envelope({ requestId: 102 }));
    const section = await incomingTable();
    await within(section).findByText('R-103');
    expect(within(section).queryByRole('button', { name: '추가 메모' })).toBeNull();
  });
});
