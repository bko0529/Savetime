'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { ExpandableBox } from '../ExpandableBox';
import { useAdminApi } from '../useAdminApi';

type AuditList =
  ApiPaths['/admin/audit-logs']['get']['responses'][200]['content']['application/json'];

// '2026. 11. 4. 오전 10:05:12' (관리자 PC 시각대로 표시만)
const timeText = (iso: string) => new Date(iso).toLocaleString('ko-KR');

// 관리자 작업 이력 (SFR-091, A-02). 고치거나 지울 수 없는 기록이라 보기만 한다
export function AuditLog() {
  const api = useAdminApi();
  const logs = useInfiniteQuery({
    queryKey: ['admin', 'audit-logs'],
    queryFn: ({ pageParam }) =>
      api<AuditList>(`/admin/audit-logs?limit=30${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];
  // 상자를 끝까지 내리면 다음 30개
  function loadMore() {
    if (logs.hasNextPage && !logs.isFetchingNextPage) void logs.fetchNextPage();
  }

  return (
    <section aria-labelledby="audit-title" className="panel">
      <h2 id="audit-title" className="section-title panel-title">
        관리자 작업 이력
      </h2>
      {logs.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(logs.error)}
        </p>
      )}
      {logs.isSuccess && items.length === 0 && (
        <p className="well px-5 py-6 text-center text-base text-muted-foreground">
          아직 기록된 작업이 없어요.
        </p>
      )}
      {items.length > 0 && (
        <ExpandableBox
          title="관리자 작업 이력"
          showMore={items.length > 4 || !!logs.hasNextPage}
          loadingMore={logs.isFetchingNextPage}
          onScrollEnd={loadMore}
          boxClassName="panel-table max-h-[330px]"
        >
          {() => (
            <table className="data-table data-table-flush">
              {/* 스크롤해도 제목 줄은 위에 고정 */}
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="text-left">
                  <th className="px-3 py-3.5">시각</th>
                  <th className="px-3 py-3.5">관리자</th>
                  <th className="px-3 py-3.5">작업</th>
                  <th className="px-3 py-3.5">대상</th>
                  <th className="px-3 py-3.5">사유</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i, n) => (
                  <tr key={`${i.at}-${n}`} className="border-b">
                    <td className="px-3 py-4 tabular-nums">{i.at ? timeText(i.at) : '—'}</td>
                    <td className="px-3 py-4">{i.admin}</td>
                    <td className="px-3 py-4 font-bold">{i.action}</td>
                    <td className="px-3 py-4">{i.target}</td>
                    <td className="px-3 py-4">{i.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ExpandableBox>
      )}
    </section>
  );
}
