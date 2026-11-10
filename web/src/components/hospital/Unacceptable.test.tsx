import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HwIncoming } from '@/app/hospital/useIncoming';
import { apiError, fakeServer, renderWithQuery } from '@/testing/render';
import { IncomingList } from './IncomingList';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const arrived = (extra: Partial<HwIncoming> = {}): HwIncoming => ({
  id: 7,
  label: 'R-7',
  summary: '남·60대 · 흉통',
  status: 'arrived',
  version: 4,
  etaMin: null,
  hasLocation: true,
  changedFields: [],
  arrivedAt: '2026-11-10T01:00:00Z',
  canConfirmArrival: false,
  canMarkUnacceptable: true,
  extraMemoUsed: false,
  ...extra,
});

const renderList = (items: HwIncoming[]) =>
  renderWithQuery(<IncomingList items={items} notices={[]} onDismiss={() => {}} />);
const row = () => screen.getByText('R-7').closest('tr')!;

describe('도착 환자 수용 불가 (SFR-158)', () => {
  it("도착 2분 된 환자에 '수용 불가'를 누르고 '해당 전문의 부재'를 골라 지금 version 과 함께 보낸다 (인수 기준)", async () => {
    const server = fakeServer({
      'POST /hw/requests/7/unacceptable': { status: 204 },
      'GET /hw/incoming': { status: 200, body: { items: [] } },
      'GET /hw/requests?status=open': { status: 200, body: { items: [], nextCursor: null } },
    });
    renderList([arrived()]);
    fireEvent.click(within(row()).getByRole('button', { name: '수용 불가' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('수용 불가 사유');
    expect(dialog.textContent).toContain('대원 앱에 경보와 함께 이 사유가 보여요');
    fireEvent.click(within(dialog).getByLabelText('해당 전문의 부재'));
    fireEvent.click(within(dialog).getByRole('button', { name: '수용 불가 보내기' }));

    await waitFor(() =>
      expect(server.callsTo('POST /hw/requests/7/unacceptable')[0].body).toEqual({
        reason: 'no_specialist',
        etcText: null,
        version: 4,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("도착 11분 된 환자(서버 canMarkUnacceptable=false)에는 '수용 불가' 버튼이 없다 (인수 기준)", () => {
    fakeServer({});
    renderList([arrived({ canMarkUnacceptable: false })]);
    expect(within(row()).queryByRole('button', { name: '수용 불가' })).toBeNull();
  });

  it('이동 중인 환자·이미 수용 불가인 환자에는 버튼이 없다', () => {
    fakeServer({});
    renderList([arrived({ status: 'confirmed', canMarkUnacceptable: false })]);
    expect(within(row()).queryByRole('button', { name: '수용 불가' })).toBeNull();
    cleanup();
    renderList([arrived({ status: 'unacceptable', canMarkUnacceptable: false })]);
    expect(row().textContent).toContain('수용 불가');
    expect(within(row()).queryByRole('button', { name: '수용 불가' })).toBeNull();
  });

  it('사유를 고르지 않으면 보내지 않는다', async () => {
    const server = fakeServer({});
    renderList([arrived()]);
    fireEvent.click(within(row()).getByRole('button', { name: '수용 불가' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '수용 불가 보내기' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(server.callsTo('POST /hw/requests/7/unacceptable')).toHaveLength(0);
  });

  it('그사이 10분이 지났으면 창을 닫고 이유를 보여 준 뒤 목록을 다시 받는다', async () => {
    const server = fakeServer({
      'POST /hw/requests/7/unacceptable': { status: 422, body: apiError('WINDOW_PASSED') },
      'GET /hw/incoming': { status: 200, body: { items: [] } },
      'GET /hw/requests?status=open': { status: 200, body: { items: [], nextCursor: null } },
    });
    renderList([arrived()]);
    fireEvent.click(within(row()).getByRole('button', { name: '수용 불가' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText('응급실 병상 부족'));
    fireEvent.click(within(dialog).getByRole('button', { name: '수용 불가 보내기' }));

    expect((await within(row()).findByRole('alert')).textContent).toBe(
      '도착 후 10분이 지나 수용 불가로 돌릴 수 없어요',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(server.callsTo('POST /hw/requests/7/unacceptable')).toHaveLength(1);
  });
});
