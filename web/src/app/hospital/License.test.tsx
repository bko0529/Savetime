import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope, FakeSocket } from '@/testing/fakeSocket';
import { apiError, fakeServer, renderWithQuery } from '@/testing/render';
import { HospitalHome } from './HospitalHome';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const HOSPITAL = { hospital: { id: 1, name: 'A병원' }, pc: { id: 7, name: '접수대' } };
const SHIFT = { id: 5, staffName: '김간호', alarmOn: false };
const NO_REQUESTS = { status: 200, body: { items: [], nextCursor: null } };
const NO_INCOMING = { status: 200, body: { items: [] } };
const BANNER = /라이선스 키가 \d+일 뒤 만료돼요/;

let socket: FakeSocket;
let createSocket: () => ReturnType<FakeSocket['asSocket']>;

beforeEach(() => {
  replace.mockClear();
  socket = new FakeSocket();
  createSocket = () => socket.asSocket();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function session(licenseDaysLeft: number, shift: typeof SHIFT | null = SHIFT) {
  return { status: 200, body: { ...HOSPITAL, licenseDaysLeft, shift } };
}

function serverWith(sessions: ReturnType<typeof session> | ReturnType<typeof session>[]) {
  return fakeServer({
    'GET /hw/session': sessions,
    'GET /hw/requests?status=open': NO_REQUESTS,
    'GET /hw/incoming': NO_INCOMING,
    'POST /hw/shifts': { status: 201, body: { shiftId: 6 } },
  });
}

describe('라이선스 키 만료 안내 배너 (SFR-168)', () => {
  it('만료 20일 전 근무 중이면 기본 색 배너를 보여 준다', async () => {
    serverWith(session(20));
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain(
      '라이선스 키가 20일 뒤 만료돼요 · 관리자에게 재발급을 요청하세요',
    );
    expect(banner.className).not.toContain('bg-destructive');
  });

  it('닫아도 다음 근무 시작 때 다시 보인다', async () => {
    serverWith([session(20, null), session(20, SHIFT), session(20, { ...SHIFT, id: 6 })]);
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    // 근무 전에는 배너가 없다
    await screen.findByLabelText('담당자 이름');
    expect(screen.queryByText(BANNER)).toBeNull();

    fireEvent.change(screen.getByLabelText('담당자 이름'), { target: { value: '김간호' } });
    fireEvent.click(screen.getByRole('button', { name: '근무 시작' }));
    expect(await screen.findByText(BANNER)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '만료 안내 닫기' }));
    expect(screen.queryByText(BANNER)).toBeNull();

    // 근무가 끝나고 새 근무(id 6)가 시작되면 다시 보인다
    socket.fire('hospital.alarm_off', envelope({ reason: 'shift_ended' }));
    expect(await screen.findByText(BANNER)).toBeTruthy();
  });

  it('7일 이하면 빨간색으로 강조한다', async () => {
    serverWith(session(7));
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    expect((await screen.findByRole('status')).className).toContain('bg-destructive');
    expect(screen.getByRole('button', { name: '만료 안내 닫기' })).toBeTruthy();
  });

  it('1일 이하면 닫기 버튼이 없다', async () => {
    serverWith(session(1));
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    expect((await screen.findByRole('status')).textContent).toContain('1일 뒤 만료돼요');
    expect(screen.queryByRole('button', { name: '만료 안내 닫기' })).toBeNull();
  });

  it('40일 남았으면 배너가 없다', async () => {
    serverWith(session(40));
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByText('알림 켜기를 다시 누르세요.');
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});

describe('키 폐기·재발급되면 병원 웹이 막힌다 (SFR-146)', () => {
  it('pc.revoked 를 받으면 PC 를 다시 확인하고, 등록이 풀렸으면 키 입력 화면으로 간다', async () => {
    const server = fakeServer({
      'GET /hw/session': [session(300), { status: 401, body: apiError('PC_NOT_REGISTERED') }],
      'GET /hw/requests?status=open': NO_REQUESTS,
      'GET /hw/incoming': NO_INCOMING,
    });
    renderWithQuery(<HospitalHome createSocket={createSocket} />);
    await screen.findByText('알림 켜기를 다시 누르세요.');
    socket.serverConnect();

    socket.fire('pc.revoked', envelope({ reason: 'key_revoked' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/hospital/register'));
    expect(server.callsTo('GET /hw/session')).toHaveLength(2);
  });
});
