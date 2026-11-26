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

  it('이미 끝난 근무면 오류 문구를 창 안에 보여 준다', async () => {
    fakeServer({
      'POST /hw/shifts/current/end': { status: 404, body: apiError('NOT_FOUND') },
    });
    renderWithQuery(<EndShiftButton />);
    fireEvent.click(screen.getByRole('button', { name: '근무 종료' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '근무 종료' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
  });
});
