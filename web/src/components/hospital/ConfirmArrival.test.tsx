import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HwIncoming } from '@/app/hospital/useIncoming';
import { apiError, fakeServer, renderWithQuery } from '@/testing/render';
import { IncomingList } from './IncomingList';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (extra: Partial<HwIncoming> = {}): HwIncoming => ({
  id: 7,
  label: 'R-7',
  summary: null,
  status: 'confirmed',
  version: 3,
  etaMin: 2,
  hasLocation: true,
  changedFields: [],
  arrivedAt: null,
  canConfirmArrival: true,
  canMarkUnacceptable: false,
  extraMemoUsed: false,
  ...extra,
});

const renderList = (items: HwIncoming[]) =>
  renderWithQuery(<IncomingList items={items} notices={[]} onDismiss={() => {}} />);

const row = () => screen.getByText('R-7').closest('tr')!;

describe('병원 웹 도착 확인 (SFR-144)', () => {
  it('입구 가까이 온 이동 중 환자는 도착 확인을 누를 수 있고, 지금 version 과 함께 보낸다', async () => {
    const server = fakeServer({
      'POST /hw/requests/7/confirm-arrival': { status: 200, body: { result: 'arrived' } },
    });
    renderList([item()]);
    fireEvent.click(within(row()).getByRole('button', { name: '도착 확인' }));
    await waitFor(() =>
      expect(server.callsTo('POST /hw/requests/7/confirm-arrival')[0].body).toEqual({ version: 3 }),
    );
  });

  it('구급차가 아직 멀면(서버가 canConfirmArrival=false) 버튼이 비활성화된다 (인수 기준: 3km 밖)', () => {
    fakeServer({});
    renderList([item({ canConfirmArrival: false })]);
    expect(within(row()).getByRole('button', { name: '도착 확인' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it("대원이 이미 도착 처리한 환자는 '도착 확인' 버튼 없이 '도착'으로 보인다 (인수 기준)", () => {
    fakeServer({});
    renderList([item({ status: 'arrived', arrivedAt: '2026-11-09T05:05:00Z' })]);
    expect(within(row()).queryByRole('button', { name: '도착 확인' })).toBeNull();
    expect(row().textContent).toContain('도착');
  });

  it('위치 없는 건이면 대원 앱에 요청했다고 알려 준다', async () => {
    fakeServer({
      'POST /hw/requests/7/confirm-arrival': { status: 200, body: { result: 'asked_paramedic' } },
    });
    renderList([item({ hasLocation: false })]);
    fireEvent.click(within(row()).getByRole('button', { name: '도착 확인' }));
    expect(await within(row()).findByText('대원 앱에 도착 처리를 요청했어요')).toBeTruthy();
  });

  it('그사이 멀어졌다고 막히면 위치·거리 없이 이유만 보여 준다', async () => {
    fakeServer({
      'POST /hw/requests/7/confirm-arrival': {
        status: 409,
        body: apiError('AMBULANCE_NOT_NEAR'),
      },
    });
    renderList([item()]);
    fireEvent.click(within(row()).getByRole('button', { name: '도착 확인' }));
    expect((await within(row()).findByRole('alert')).textContent).toBe(
      '구급차가 아직 응급실 입구 가까이 오지 않았어요',
    );
  });

  it('빠르게 두 번 눌러도 한 번만 보낸다', async () => {
    const server = fakeServer({
      'POST /hw/requests/7/confirm-arrival': { status: 200, body: { result: 'arrived' } },
    });
    renderList([item()]);
    const button = within(row()).getByRole('button', { name: '도착 확인' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(server.callsTo('POST /hw/requests/7/confirm-arrival')).toHaveLength(1),
    );
  });
});
