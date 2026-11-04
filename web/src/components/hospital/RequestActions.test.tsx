import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer, renderWithQuery } from '@/testing/render';
import { RequestDetail } from './RequestDetail';

const NOW = Date.parse('2026-11-03T14:00:00Z');
const DETAIL = 'GET /hw/requests/102';
const APPROVE = 'POST /hw/requests/102/approve';
const REJECT = 'POST /hw/requests/102/reject';

function detail(extra: object = {}) {
  return {
    status: 200,
    body: {
      id: 102,
      label: 'R-102',
      version: 3,
      status: 'waiting',
      respondUntil: new Date(NOW + 60_000).toISOString(),
      serverNow: new Date(NOW).toISOString(),
      assessment: { chiefComplaint: '흉통', unknownFields: [] },
      abnormalFields: [],
      etaMin: 9,
      etaSource: 'route',
      ourHospital: { capability: null, beds: { er: '5/20', icu: '0/10', or: '1/4' } },
      ...extra,
    },
  };
}

function open(routes: Parameters<typeof fakeServer>[0]) {
  const server = fakeServer({ [DETAIL]: detail(), ...routes });
  renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
  return server;
}

// 거절 사유 창 (열려 있는 대화상자)
const reasonDialog = () => screen.findByRole('dialog');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('승인 (SFR-119)', () => {
  it('승인을 누르면 상세를 열 때 받은 version 과 함께 보내고, 상세를 새로 받는다', async () => {
    const server = open({
      [APPROVE]: { status: 200, body: { status: 'approved', respondedBy: '박서연', version: 4 } },
    });
    const button = await screen.findByRole('button', { name: '승인' });
    // 승인 뒤 다시 받을 상세
    server.set(DETAIL, detail({ status: 'approved', respondedBy: '박서연', version: 4 }));
    fireEvent.click(button);

    await waitFor(() => expect(server.callsTo(APPROVE)).toHaveLength(1));
    expect(server.callsTo(APPROVE)[0].body).toEqual({ version: 3 });
    expect(await screen.findByText('박서연 님이 승인함')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '승인' })).toBeNull();
  });

  it('다른 PC가 먼저 응답했으면 누가 했는지 알려 주고 최신 상태로 바꾼다 (SFR-153)', async () => {
    const server = open({
      [APPROVE]: {
        status: 409,
        body: apiError('ALREADY_RESPONDED', {
          respondedBy: '박서연',
          pcName: '처치실',
          status: 'approved',
        }),
      },
    });
    const button = await screen.findByRole('button', { name: '승인' });
    server.set(DETAIL, detail({ status: 'approved', respondedBy: '박서연' }));
    fireEvent.click(button);

    expect(await screen.findByText('다른 PC에서 이미 승인했어요 (박서연 · 처치실)')).toBeTruthy();
    expect(await screen.findByText('박서연 님이 승인함')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '거절' })).toBeNull();
  });

  it('2분이 지났으면 응답 시간이 지났다고 알려 준다', async () => {
    open({ [APPROVE]: { status: 409, body: apiError('REQUEST_EXPIRED') } });
    fireEvent.click(await screen.findByRole('button', { name: '승인' }));
    expect(await screen.findByText('응답 시간(2분)이 지났어요')).toBeTruthy();
  });

  it('누르는 중에는 두 번 보내지 않는다', async () => {
    const server = open({ [APPROVE]: { status: 200, body: { status: 'approved', version: 4 } } });
    const button = await screen.findByRole('button', { name: '승인' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(server.callsTo(APPROVE)).toHaveLength(1));
  });
});

describe('거절 (SFR-119)', () => {
  it('사유 없이 거절하면 보내지 않고 사유를 고르라고 한다', async () => {
    const server = open({ [REJECT]: { status: 200, body: { status: 'rejected', version: 4 } } });
    fireEvent.click(await screen.findByRole('button', { name: '거절' }));
    const dialog = await reasonDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '거절 보내기' }));

    expect(within(dialog).getByText('거절 사유를 골라 주세요')).toBeTruthy();
    expect(server.callsTo(REJECT)).toHaveLength(0);
  });

  it('사유를 고르면 그 사유와 version 을 보낸다', async () => {
    const server = open({ [REJECT]: { status: 200, body: { status: 'rejected', version: 4 } } });
    fireEvent.click(await screen.findByRole('button', { name: '거절' }));
    const dialog = await reasonDialog();
    // '요청 중지'는 시스템 사유라 목록에 없다
    expect(within(dialog).queryByLabelText(/요청 중지/)).toBeNull();
    expect(within(dialog).getAllByRole('radio')).toHaveLength(7);

    fireEvent.click(within(dialog).getByLabelText('해당 전문의 부재'));
    fireEvent.click(within(dialog).getByRole('button', { name: '거절 보내기' }));

    await waitFor(() => expect(server.callsTo(REJECT)).toHaveLength(1));
    expect(server.callsTo(REJECT)[0].body).toEqual({
      reason: 'no_specialist',
      etcText: null,
      version: 3,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("'기타'는 20자까지만 입력되고, 비우면 보내지 않는다", async () => {
    const server = open({ [REJECT]: { status: 200, body: { status: 'rejected', version: 4 } } });
    fireEvent.click(await screen.findByRole('button', { name: '거절' }));
    const dialog = await reasonDialog();
    fireEvent.click(within(dialog).getByLabelText('기타'));
    const input = within(dialog).getByRole('textbox');

    fireEvent.click(within(dialog).getByRole('button', { name: '거절 보내기' }));
    expect(within(dialog).getByText('기타 사유를 적어 주세요')).toBeTruthy();

    fireEvent.change(input, { target: { value: '가'.repeat(21) } });
    expect((input as HTMLInputElement).value).toHaveLength(20);
    fireEvent.click(within(dialog).getByRole('button', { name: '거절 보내기' }));

    await waitFor(() => expect(server.callsTo(REJECT)).toHaveLength(1));
    expect(server.callsTo(REJECT)[0].body).toEqual({
      reason: 'etc',
      etcText: '가'.repeat(20),
      version: 3,
    });
  });

  it('취소하면 창만 닫고 보내지 않는다', async () => {
    const server = open({});
    fireEvent.click(await screen.findByRole('button', { name: '거절' }));
    const dialog = await reasonDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.callsTo(REJECT)).toHaveLength(0);
  });
});

describe('응답할 수 없는 요청', () => {
  it('이미 승인한 요청에는 버튼이 없다', async () => {
    open({ [DETAIL]: detail({ status: 'approved', respondedBy: '박서연' }) });
    await screen.findByText('박서연 님이 승인함');
    expect(screen.queryByRole('button', { name: '승인' })).toBeNull();
    expect(screen.queryByRole('button', { name: '거절' })).toBeNull();
  });

  it('남은 시간이 0이면 버튼이 없다 (서버 판정 전이라도)', async () => {
    open({ [DETAIL]: detail({ respondUntil: new Date(NOW - 1000).toISOString() }) });
    await screen.findByText('흉통');
    expect(screen.queryByRole('button', { name: '승인' })).toBeNull();
  });
});
