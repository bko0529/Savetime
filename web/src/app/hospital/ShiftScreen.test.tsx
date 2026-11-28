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

const resumes = () => socket.emitted.filter((e) => e.event === 'alarm.resume');

describe('근무 시작 → 자동으로 요청 받기 (SFR-117)', () => {
  it('담당자 이름으로 근무를 시작하면 누를 것 없이 이 탭이 요청 받기로 등록된다', async () => {
    const server = fakeServer({
      'GET /hw/session': [
        { status: 200, body: { ...HOSPITAL, shift: null } },
        { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      ],
      'POST /hw/shifts': { status: 201, body: { shiftId: 5 } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    // 소켓은 PC 확인(GET /hw/session)이 끝나고 화면이 뜬 뒤에 만들어진다
    const nameInput = await screen.findByLabelText('담당자 이름');
    socket.serverConnect('sock-1');
    // 근무 전에는 등록하지 않는다
    expect(resumes()).toEqual([]);

    fireEvent.change(nameInput, { target: { value: ' 김간호 ' } });
    fireEvent.click(screen.getByRole('button', { name: '근무 시작' }));

    await waitFor(() => expect(resumes()).toHaveLength(1));
    expect(resumes()[0].args[0]).toEqual({ shiftId: 5 });
    expect(server.callsTo('POST /hw/shifts')[0].body).toEqual({ staffName: '김간호' });
    // '알림 켜기' 버튼·안내는 없다
    expect(screen.queryByRole('button', { name: '알림 켜기' })).toBeNull();
    expect(screen.queryByText(/알림 켜기/)).toBeNull();
    expect(screen.getByText(/김간호/)).toBeDefined();
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

  it('이미 근무 중인 화면을 새로 열어도 연결되자마자 자동으로 등록한다', async () => {
    fakeServer({
      'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByRole('tab', { name: /요청/ });
    // 연결 전에는 보낼 수 없다
    expect(resumes()).toEqual([]);
    socket.serverConnect();
    expect(resumes().map((e) => e.args[0])).toEqual([{ shiftId: 5 }]);
  });
});

describe('연결 끊김·자동 다시 등록', () => {
  async function renderOnShift() {
    const server = fakeServer({
      'GET /hw/session': { status: 200, body: { ...HOSPITAL, shift: SHIFT } },
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByRole('tab', { name: /요청/ });
    socket.serverConnect('sock-1');
    return server;
  }

  it('끊기면 맨 위에 빨간 연결 끊김 배너, 다시 붙으면 자동으로 다시 등록', async () => {
    await renderOnShift();

    socket.serverDisconnect();
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toBe('연결 끊김 — 새 요청을 받을 수 없어요');
    // 근무 화면의 맨 위 (SFR-122)
    expect(banner.parentElement?.firstElementChild).toBe(banner);

    socket.serverConnect('sock-2');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(resumes()).toHaveLength(2);
    expect(resumes()[1].args[0]).toEqual({ shiftId: 5 });
  });

  it('응답이 없어 서버가 등록을 풀면(no_ack) 사람이 할 일 없이 곧바로 다시 등록', async () => {
    await renderOnShift();
    socket.fire('hospital.alarm_off', envelope({ reason: 'no_ack' }));
    expect(resumes()).toHaveLength(2);
    expect(screen.queryByText(/알림/)).toBeNull();
  });

  it('서버가 등록을 거부하면(근무가 이미 끝남) 근무 정보를 다시 받는다', async () => {
    socket.resumeOk = false;
    const server = await renderOnShift();
    await waitFor(() => expect(server.callsTo('GET /hw/session')).toHaveLength(2));
  });

  it('근무가 끝나면 근무 정보를 다시 받아 근무 시작 화면으로', async () => {
    const server = await renderOnShift();
    server.set('GET /hw/session', { status: 200, body: { ...HOSPITAL, shift: null } });
    socket.fire('hospital.alarm_off', envelope({ reason: 'shift_ended' }));
    expect(await screen.findByLabelText('담당자 이름')).toBeDefined();
    expect(server.callsTo('GET /hw/session')).toHaveLength(2);
    expect(resumes()).toHaveLength(1);
  });
});
