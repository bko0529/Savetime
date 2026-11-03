import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRemaining, NewRequestOverlay, type OverlayRequest } from './NewRequestOverlay';

afterEach(cleanup);

const NOW = Date.parse('2026-11-03T05:00:00Z');
const request: OverlayRequest = {
  id: 102,
  label: 'R-102',
  chiefComplaint: '흉통',
  etaMin: 8,
  respondUntil: new Date(NOW + 95_000).toISOString(),
};

function renderOverlay(props: Partial<Parameters<typeof NewRequestOverlay>[0]> = {}) {
  const onConfirm = vi.fn();
  render(
    <NewRequestOverlay
      request={request}
      pendingCount={1}
      nowMs={NOW}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm };
}

describe('NewRequestOverlay', () => {
  it('요청 요약과 확인 버튼만 보여준다', () => {
    renderOverlay();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('R-102')).toBeDefined();
    expect(screen.getByText('흉통')).toBeDefined();
    expect(screen.getByText('도착 예상 8분')).toBeDefined();
    expect(screen.getByText('응답 남은 시간 1분 35초')).toBeDefined();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['확인']);
  });

  it('1건이면 건수 없이, 여러 건이면 대기 건수를 표시', () => {
    renderOverlay();
    expect(screen.queryByText(/대기 \d+건/)).toBeNull();
    cleanup();
    renderOverlay({ pendingCount: 3 });
    expect(screen.getByText('대기 3건')).toBeDefined();
  });

  // Base UI 는 닫기 시작하면 창에 data-closed 를 붙인다.
  // 주의: jsdom 에서는 cancel() 이 없어도 이 테스트가 통과한다. Esc 로 안 닫히는지는 실제 브라우저에서도 확인할 것
  // (/hospital/design-preview 에서 '새 요청 오게 하기' → Esc)
  it('Esc 를 눌러도 닫히지 않는다', async () => {
    const { onConfirm } = renderOverlay();
    await act(() => new Promise((r) => setTimeout(r, 50))); // Base UI 가 키 감시를 붙일 시간
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    const dialog = screen.getByRole('dialog');
    expect(dialog.hasAttribute('data-closed')).toBe(false);
    expect(dialog.hasAttribute('data-open')).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('바깥을 눌러도 닫히지 않는다', () => {
    renderOverlay();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(screen.getByRole('dialog').hasAttribute('data-closed')).toBe(false);
  });

  it('확인을 누르면 그 요청 id 로 알린다', () => {
    const { onConfirm } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(onConfirm).toHaveBeenCalledWith(102);
  });

  it('요청이 없으면 창이 없다', () => {
    renderOverlay({ request: null });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('formatRemaining', () => {
  it('마감이 지나면 0초', () => {
    expect(formatRemaining(new Date(NOW - 5000).toISOString(), NOW)).toBe('0분 00초');
  });
});
