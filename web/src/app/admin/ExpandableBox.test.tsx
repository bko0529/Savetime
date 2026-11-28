import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpandableBox } from './ExpandableBox';

afterEach(cleanup);

const list = (n: number) => (
  <ul>
    {Array.from({ length: n }, (_, i) => (
      <li key={i}>항목 {i + 1}</li>
    ))}
  </ul>
);

describe('관리자 목록: 낮은 상자 + 더 보기 큰 창', () => {
  it("'더 보기'를 누르면 큰 창에 전체 목록이 열린다", () => {
    render(
      <ExpandableBox title="관리자 알림" label="알림 더 보기" showMore>
        {() => list(12)}
      </ExpandableBox>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '관리자 알림 알림 더 보기' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '관리자 알림' })).toBeTruthy();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(12);
  });

  it('항목이 적으면 버튼이 없고, 상자 끝까지 내리면 다음 쪽을 부른다', () => {
    const onScrollEnd = vi.fn();
    render(
      <ExpandableBox title="대원 계정" showMore={false} onScrollEnd={onScrollEnd}>
        {() => list(2)}
      </ExpandableBox>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.scroll(screen.getByTestId('대원 계정 상자'));
    expect(onScrollEnd).toHaveBeenCalled();
  });
});
