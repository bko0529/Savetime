import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as alarm from '@/lib/alarm/browserAlarm';
import { envelope, FakeSocket } from '@/testing/fakeSocket';
import { fakeServer, renderWithQuery } from '@/testing/render';
import { HospitalHome } from './HospitalHome';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
// 권한 답을 테스트마다 바꾼다. 소리·브라우저 알림은 불렸는지만 본다
vi.mock('@/lib/alarm/browserAlarm', () => ({
  unlockSound: vi.fn(async () => true),
  askNotificationPermission: vi.fn(async () => 'denied'),
  notificationPermission: vi.fn(() => 'denied'),
  startAlarmLoop: vi.fn(),
  stopAlarmLoop: vi.fn(),
  showRequestNotification: vi.fn(),
}));

const LIST = 'GET /hw/requests?status=open';
const GUIDE = '⚠ 브라우저 알림을 허용해야 다른 창을 볼 때도 알 수 있어요';

let socket: FakeSocket;
let server: ReturnType<typeof fakeServer>;

function setPermission(state: alarm.PermissionState) {
  vi.mocked(alarm.notificationPermission).mockReturnValue(state);
  vi.mocked(alarm.askNotificationPermission).mockResolvedValue(state);
}

async function openAndTurnOn() {
  renderWithQuery(<HospitalHome createSocket={() => socket.asSocket()} />);
  await screen.findByText('알림 켜기를 다시 누르세요.');
  socket.serverConnect();
  fireEvent.click(screen.getByRole('button', { name: '알림 켜기' }));
  await screen.findByText(/알림 켜짐/);
}

beforeEach(() => {
  vi.clearAllMocks();
  document.title = '세이브타임';
  socket = new FakeSocket();
  server = fakeServer({
    'GET /hw/session': {
      status: 200,
      body: {
        hospital: { id: 1, name: 'A병원' },
        pc: { id: 7, name: '접수대' },
        shift: { id: 5, staffName: '박서연', alarmOn: true },
      },
    },
    'POST /hw/shifts/current/alarm-on': { status: 200, body: { shiftId: 9 } },
    [LIST]: { status: 200, body: { items: [], nextCursor: null } },
    'GET /hw/incoming': { status: 200, body: { items: [] } },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('알림 권한이 막혀 있을 때 (SFR-136)', () => {
  // 위쪽 노란 안내 상자는 화면을 가려서 뺐다. 대신 알림음 반복·탭 제목·목록으로 알린다
  it('권한이 거부돼 있어도 안내 상자를 띄우지 않는다', async () => {
    setPermission('denied');
    await openAndTurnOn();
    expect(screen.queryByText(GUIDE)).toBeNull();
    expect(screen.queryByRole('status', { name: '브라우저 알림 안내' })).toBeNull();
  });

  it('거부된 상태에서 새 요청이 오면 알림음 반복과 탭 제목으로 알린다', async () => {
    setPermission('denied');
    await openAndTurnOn();
    server.set(LIST, {
      status: 200,
      body: {
        items: [
          {
            id: 101,
            label: 'R-101',
            status: 'waiting',
            chiefComplaint: '흉통',
            etaMin: 8,
            respondUntil: new Date(Date.now() + 100_000).toISOString(),
            version: 1,
          },
        ],
        nextCursor: null,
        serverNow: new Date().toISOString(),
      },
    });
    socket.fire(
      'request.new',
      envelope({ requestId: 101, label: '새 이송 요청', respondUntil: new Date().toISOString() }),
      vi.fn(),
    );
    await waitFor(() => expect(document.title).toBe('🔴 새 이송 요청 1건'));
    expect(alarm.startAlarmLoop).toHaveBeenCalled();
  });
});
