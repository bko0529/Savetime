import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertTitle, BLINK_MS, useTabTitleAlert } from './useTabTitleAlert';

describe('useTabTitleAlert', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.title = '세이브타임';
  });
  afterEach(() => vi.useRealTimers());

  it('대기 0건이면 제목을 건드리지 않는다', () => {
    renderHook(() => useTabTitleAlert(0));
    vi.advanceTimersByTime(BLINK_MS * 3);
    expect(document.title).toBe('세이브타임');
  });

  it('대기가 있으면 알림 제목과 원래 제목을 번갈아 보여준다', () => {
    renderHook(() => useTabTitleAlert(1));
    expect(document.title).toBe(alertTitle(1));
    vi.advanceTimersByTime(BLINK_MS);
    expect(document.title).toBe('세이브타임');
    vi.advanceTimersByTime(BLINK_MS);
    expect(document.title).toBe('🔴 새 이송 요청 1건');
  });

  it('건수가 바뀌면 새 건수로, 0건이 되면 원래 제목으로', () => {
    const { rerender } = renderHook(({ n }) => useTabTitleAlert(n), { initialProps: { n: 1 } });
    vi.advanceTimersByTime(BLINK_MS); // 원래 제목이 보이는 순간에 바뀌어도
    rerender({ n: 3 });
    expect(document.title).toBe(alertTitle(3));
    rerender({ n: 0 });
    expect(document.title).toBe('세이브타임');
  });

  it('화면을 떠나면 원래 제목으로', () => {
    const { unmount } = renderHook(() => useTabTitleAlert(2));
    unmount();
    expect(document.title).toBe('세이브타임');
    vi.advanceTimersByTime(BLINK_MS * 2);
    expect(document.title).toBe('세이브타임');
  });
});
