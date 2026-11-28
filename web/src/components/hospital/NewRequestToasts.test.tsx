import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewRequestToasts, TOAST_MS } from './NewRequestToasts';

const REQ = {
  id: 101,
  label: 'R-101',
  chiefComplaint: '흉통',
  etaMin: 8,
  respondUntil: new Date(Date.now() + 100_000).toISOString(),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('새 요청 작은 알림', () => {
  it('요청 번호·주 증상·도착 예상을 보여주고, 누르면 그 요청을 열고 알림을 닫는다', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<NewRequestToasts toasts={[REQ]} onOpen={onOpen} onClose={onClose} />);

    const toast = screen.getByRole('listitem');
    expect(toast.textContent).toContain('새 이송 요청');
    expect(toast.textContent).toContain('R-101 · 흉통 · 도착 약 8분');

    fireEvent.click(
      screen.getByRole('button', { name: '새 이송 요청 R-101 · 흉통 · 도착 약 8분 열기' }),
    );
    expect(onOpen).toHaveBeenCalledWith(101);
    expect(onClose).toHaveBeenCalledWith(101);
  });

  it('× 를 누르면 열지 않고 닫기만 한다', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<NewRequestToasts toasts={[REQ]} onOpen={onOpen} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'R-101 알림 닫기' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(101);
  });

  it('가만히 두면 잠시 뒤 저절로 닫힌다', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<NewRequestToasts toasts={[REQ]} onOpen={vi.fn()} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(TOAST_MS - 1));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledWith(101);
  });
});
