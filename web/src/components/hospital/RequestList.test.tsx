import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestList, type HwRequestItem } from './RequestList';

const NOW = Date.parse('2026-11-03T14:00:00Z');
const at = (sec: number) => new Date(NOW + sec * 1000).toISOString();

function item(id: number, respondInSec: number, extra: Partial<HwRequestItem> = {}): HwRequestItem {
  return {
    id,
    label: `R-${id}`,
    status: 'waiting',
    chiefComplaint: '흉통',
    etaMin: 9,
    etaSource: 'straight',
    respondUntil: at(respondInSec),
    abnormalCount: 0,
    version: 1,
    ...extra,
  };
}

afterEach(cleanup);

describe('요청 목록 (SFR-135)', () => {
  it('서버가 준 순서(남은 시간 짧은 순) 그대로, 남은 시간·상태·도착 예상을 보여 준다', () => {
    render(
      <RequestList
        items={[item(3, 40), item(1, 80), item(2, 110)]}
        nowMs={NOW}
        selectedId={null}
        onOpen={() => {}}
      />,
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      'R-3',
      'R-1',
      'R-2',
    ]);
    expect(within(rows[0]).getByText('0:40')).toBeTruthy();
    expect(within(rows[0]).getByText('응답 대기')).toBeTruthy();
    expect(within(rows[0]).getByText('약 9분')).toBeTruthy();
  });

  it('남은 시간 30초 이하는 빨간색 (0:25)', () => {
    render(
      <RequestList
        items={[item(1, 25), item(2, 31)]}
        nowMs={NOW}
        selectedId={null}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('0:25').className).toContain('text-destructive');
    expect(screen.getByText('0:31').className).not.toContain('text-destructive');
  });

  it('이상 수치 개수를 보여 준다 (SFR-155)', () => {
    render(
      <RequestList
        items={[item(1, 60, { abnormalCount: 2 }), item(2, 90)]}
        nowMs={NOW}
        selectedId={null}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('⚠ 이상 2')).toBeTruthy();
  });

  it('승인한 요청은 남은 시간 대신 누가 승인했는지', () => {
    render(
      <RequestList
        items={[item(1, 60, { status: 'approved', respondedBy: '박서연' })]}
        nowMs={NOW}
        selectedId={null}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('승인 · 박서연')).toBeTruthy();
  });

  it('번호를 누르면 그 요청을 연다', () => {
    const onOpen = vi.fn();
    render(<RequestList items={[item(7, 60)]} nowMs={NOW} selectedId={null} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'R-7' }));
    expect(onOpen).toHaveBeenCalledWith(7);
  });

  it('요청이 없으면 안내 문구', () => {
    render(<RequestList items={[]} nowMs={NOW} selectedId={null} onOpen={() => {}} />);
    expect(screen.getByText('지금 응답할 요청이 없어요.')).toBeTruthy();
  });
});
