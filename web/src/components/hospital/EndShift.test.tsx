import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer, renderWithQuery } from '@/testing/render';
import { EndShiftButton } from './EndShiftButton';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('근무 종료 (SFR-117)', () => {
  it('한 번 더 물은 뒤 근무 종료를 보낸다', async () => {
    const server = fakeServer({ 'POST /hw/shifts/current/end': { status: 204 } });
    renderWithQuery(<EndShiftButton staffName="김하늘" />);

    fireEvent.click(screen.getByRole('button', { name: '근무 종료' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('근무를 끝낼까요?')).toBeTruthy();
    expect(dialog.textContent).toContain('김하늘 님의 근무를 끝내요');
    // 창만 열었을 때는 아직 보내지 않는다
    expect(server.callsTo('POST /hw/shifts/current/end')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: '근무 종료' }));
    await waitFor(() => expect(server.callsTo('POST /hw/shifts/current/end')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('취소하면 보내지 않는다', async () => {
    const server = fakeServer({ 'POST /hw/shifts/current/end': { status: 204 } });
    renderWithQuery(<EndShiftButton />);
    fireEvent.click(screen.getByRole('button', { name: '근무 종료' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '취소' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.callsTo('POST /hw/shifts/current/end')).toHaveLength(0);
  });

  it('다른 탭에서 이미 끝낸 근무(404)면 오류 없이 창을 닫는다 (근무 시작 화면으로)', async () => {
    fakeServer({
      'POST /hw/shifts/current/end': { status: 404, body: apiError('NOT_FOUND') },
    });
    renderWithQuery(<EndShiftButton />);
    fireEvent.click(screen.getByRole('button', { name: '근무 종료' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '근무 종료' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('그 밖의 오류는 창 안에 문구를 보여 주고 창을 닫지 않는다', async () => {
    fakeServer({
      'POST /hw/shifts/current/end': { status: 500, body: apiError('INTERNAL') },
    });
    renderWithQuery(<EndShiftButton />);
    fireEvent.click(screen.getByRole('button', { name: '근무 종료' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '근무 종료' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
  });

  it('응답하지 않은 요청이 있으면 몇 건인지 알려 준다', async () => {
    fakeServer({ 'POST /hw/shifts/current/end': { status: 204 } });
    renderWithQuery(<EndShiftButton waitingCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: '근무 종료' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('아직 응답하지 않은 요청 2건이 있어요.');
    // 알림 켜기는 없어졌으니 옛 문구가 남아 있으면 안 된다
    expect(dialog.textContent).not.toContain('알림을 켜');
  });

  it('응답할 요청이 없으면 건수 문구가 없다', async () => {
    fakeServer({ 'POST /hw/shifts/current/end': { status: 204 } });
    renderWithQuery(<EndShiftButton />);
    fireEvent.click(screen.getByRole('button', { name: '근무 종료' }));
    expect((await screen.findByRole('dialog')).textContent).not.toContain('응답하지 않은 요청');
  });
});
