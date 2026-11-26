import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShowMoreButtons, useShowMore } from './ShowMore';

function List({
  n,
  hasNextPage = false,
  fetchNextPage = () => {},
}: {
  n: number;
  hasNextPage?: boolean;
  fetchNextPage?: () => void;
}) {
  const items = Array.from({ length: n }, (_, i) => `항목 ${i + 1}`);
  const shown = useShowMore(items, { hasNextPage, fetchNextPage });
  return (
    <>
      <ul>
        {shown.visible.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <ShowMoreButtons
        hasMore={shown.hasMore}
        canCollapse={shown.canCollapse}
        onMore={shown.more}
        onCollapse={shown.collapse}
      />
    </>
  );
}

afterEach(cleanup);

describe('관리자 목록 더 보기', () => {
  it('처음엔 3개, 더 보기마다 10개씩, 접기로 다시 3개', () => {
    render(<List n={18} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(13);
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(18);
    // 다 보여 주면 더 보기는 없고 접기만
    expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '접기' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('3개 이하면 버튼이 없다', () => {
    render(<List n={3} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('받아 둔 게 모자라고 서버에 다음 쪽이 있으면 그때 받는다', () => {
    const fetchNextPage = vi.fn();
    render(<List n={5} hasNextPage fetchNextPage={fetchNextPage} />);
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
