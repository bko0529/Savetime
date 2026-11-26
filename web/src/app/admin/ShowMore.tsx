'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

// 관리자 목록을 처음엔 몇 개만 보여 주고 '더 보기'로 늘린다.
// 받아 둔 항목을 다 보여 줬는데 서버에 다음 쪽이 있으면 그때 서버에서 더 받는다
export function useShowMore<T>(
  items: T[],
  {
    first = 5,
    step = 10,
    hasNextPage = false,
    fetchNextPage,
  }: {
    first?: number;
    step?: number;
    hasNextPage?: boolean;
    fetchNextPage?: () => unknown;
  } = {},
) {
  const [count, setCount] = useState(first);
  const visible = items.slice(0, count);
  const hasMore = items.length > count || hasNextPage;
  return {
    visible,
    hasMore,
    canCollapse: count > first && items.length > first,
    more: () => {
      const next = count + step;
      setCount(next);
      // 받아 둔 것만으로 모자라면 다음 쪽을 받는다
      if (next > items.length && hasNextPage) void fetchNextPage?.();
    },
    collapse: () => setCount(first),
  };
}

export function ShowMoreButtons({
  hasMore,
  canCollapse,
  loading,
  onMore,
  onCollapse,
  label = '더 보기',
}: {
  hasMore: boolean;
  canCollapse: boolean;
  loading?: boolean;
  onMore: () => void;
  onCollapse: () => void;
  label?: string;
}) {
  if (!hasMore && !canCollapse) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {hasMore && (
        // 화살표는 꾸밈이라 이름에서 뺀다 ('더 보기'로 읽힘)
        <Button variant="outline" size="lg" disabled={loading} onClick={onMore} aria-label={label}>
          {loading ? '불러오는 중…' : `${label} ▾`}
        </Button>
      )}
      {canCollapse && (
        <Button variant="ghost" size="lg" onClick={onCollapse} aria-label="접기">
          접기 ▴
        </Button>
      )}
    </div>
  );
}
