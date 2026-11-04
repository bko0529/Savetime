import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope, FakeSocket } from '@/testing/fakeSocket';
import { fakeServer, renderWithQuery } from '@/testing/render';
import { HospitalHome } from './HospitalHome';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

const HOSPITAL = { hospital: { id: 1, name: 'A병원' }, pc: { id: 7, name: '접수대' } };
const SHIFT = { id: 5, staffName: '김간호', alarmOn: false };
const NO_REQUESTS = { status: 200, body: { items: [], nextCursor: null } };
const NO_INCOMING = { status: 200, body: { items: [] } };

let socket: FakeSocket;
let createSocket: () => ReturnType<FakeSocket['asSocket']>;

beforeEach(() => {
  socket = new FakeSocket();
  createSocket = () => socket.asSocket();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const alarmButton = () => screen.getByRole('button', { name: '알림 켜기' });

describe('근무 시작 → 알림 켜기 (SFR-117)', () => {
  it('담당자 이름으로 근무를 시작하고, 알림 켜기를 누르면 이 탭의 socketId 를 보낸다', async () => {
    const server = fakeServer({
      'GET /hw/session': [
        { status: 200, body: { ...HOSPITAL, shift: null } },
        { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      ],
      'POST /hw/shifts': { status: 201, body: { shiftId: 9 } },
      'POST /hw/shifts/current/alarm-on': { status: 200, body: { shiftId: 9 } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    // 소켓은 PC 확인(GET /hw/session)이 끝나고 화면이 뜬 뒤에 만들어진다
    const nameInput = await screen.findByLabelText('담당자 이름');
    socket.serverConnect('sock-1');

    fireEvent.change(nameInput, { target: { value: ' 김간호 ' } });
    fireEvent.click(screen.getByRole('button', { name: '근무 시작' }));

    expect(await screen.findByText('알림 켜기를 눌러야 새 요청을 받아요.')).toBeDefined();
    expect(server.callsTo('POST /hw/shifts')[0].body).toEqual({ staffName: '김간호' });

    fireEvent.click(alarmButton());
    expect(await screen.findByText(/알림 켜짐 · 김간호 님 근무 중/)).toBeDefined();
    expect(server.callsTo('POST /hw/shifts/current/alarm-on')[0].body).toEqual({
      socketId: 'sock-1',
    });
  });

  it('근무 전에는 요청 목록을 부르지 않는다', async () => {
    const server = fakeServer({
      'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: null } },
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByLabelText('담당자 이름');
    socket.serverConnect();
    expect(server.callsTo('GET /hw/requests?status=open')).toEqual([]);
  });

  it('이미 근무 중인데 새로 열었으면 다시 누르라고 크게 알려준다', async () => {
    fakeServer({
      'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    expect(await screen.findByText('알림 켜기를 다시 누르세요.')).toBeDefined();
  });

  it('실시간 연결 전에는 알림 켜기를 누를 수 없다', async () => {
    fakeServer({
      'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByText('알림 켜기를 다시 누르세요.');
    expect(alarmButton()).toHaveProperty('disabled', true);
    socket.serverConnect();
    expect(alarmButton()).toHaveProperty('disabled', false);
  });
});

describe('연결 끊김·자동 복구·꺼짐', () => {
  async function renderWithAlarmOn() {
    const server = fakeServer({
      'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      'POST /hw/shifts/current/alarm-on': { status: 200, body: { shiftId: 9 } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByText('알림 켜기를 다시 누르세요.');
    socket.serverConnect('sock-1');
    fireEvent.click(alarmButton());
    await screen.findByText(/알림 켜짐/);
    return server;
  }

  it('끊기면 맨 위에 빨간 연결 끊김 배너, 탭을 유지한 채 다시 붙으면 shiftId 로 자동 복구', async () => {
    await renderWithAlarmOn();

    socket.serverDisconnect();
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toBe('연결 끊김 — 새 요청을 받을 수 없어요');
    // 근무 화면의 맨 위 (SFR-122)
    expect(banner.parentElement?.firstElementChild).toBe(banner);

    socket.serverConnect('sock-2');
    expect(screen.queryByRole('alert')).toBeNull();
    const resume = socket.emitted.at(-1);
    expect(resume?.event).toBe('alarm.resume');
    expect(resume?.args[0]).toEqual({ shiftId: 9 });
    expect(screen.getByText(/알림 켜짐/)).toBeDefined();
  });

  it('서버가 복구를 거부하면 다시 누르라고 안내', async () => {
    await renderWithAlarmOn();
    socket.resumeOk = false;
    socket.serverDisconnect();
    socket.serverConnect('sock-2');
    expect(screen.getByText(/알림을 복구하지 못했어요/)).toBeDefined();
    expect(alarmButton()).toBeDefined();
  });

  it('처음 연결될 때는 복구를 시도하지 않는다 (켠 적이 없으므로)', async () => {
    fakeServer({
      'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByText('알림 켜기를 다시 누르세요.');
    socket.serverConnect();
    expect(socket.emitted).toEqual([]);
  });

  it('응답이 없어 서버가 알림을 끄면 다시 켜 달라고 안내', async () => {
    await renderWithAlarmOn();
    socket.fire('hospital.alarm_off', envelope({ reason: 'no_ack' }));
    expect(screen.getByText(/응답하지 않아 알림이 꺼졌어요/)).toBeDefined();
  });

  it('근무가 끝나면 근무 정보를 다시 받아 근무 시작 화면으로', async () => {
    const server = await renderWithAlarmOn();
    server.set('GET /hw/session', { status: 200, body: { ...HOSPITAL, shift: null } });
    socket.fire('hospital.alarm_off', envelope({ reason: 'shift_ended' }));
    expect(await screen.findByLabelText('담당자 이름')).toBeDefined();
    expect(server.callsTo('GET /hw/session')).toHaveLength(2);
  });
});

describe('알림 켜기 실패', () => {
  it('서버 오류면 문구를 보여주고 꺼진 상태로 남는다', async () => {
    fakeServer({
      'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
      'POST /hw/shifts/current/alarm-on': {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: '근무 중이 아니에요' } },
      },
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByText('알림 켜기를 다시 누르세요.');
    socket.serverConnect();
    fireEvent.click(alarmButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('근무 중이 아니에요'));
    expect(screen.queryByText(/알림 켜짐/)).toBeNull();
  });
});
