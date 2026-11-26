'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { ShowMoreButtons, useShowMore } from '../ShowMore';
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
  // 처음엔 5개만, '더 보기'로 10개씩 (받아 둔 게 모자라면 서버에서 다음 쪽)
  const shown = useShowMore(items, {
    hasNextPage: logs.hasNextPage,
    fetchNextPage: logs.fetchNextPage,
  });

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
        <div className="panel-table">
          <table className="data-table data-table-flush">
            <thead>
              <tr className="text-left">
                <th className="px-3 py-3.5">시각</th>
                <th className="px-3 py-3.5">관리자</th>
                <th className="px-3 py-3.5">작업</th>
                <th className="px-3 py-3.5">대상</th>
                <th className="px-3 py-3.5">사유</th>
              </tr>
            </thead>
            <tbody>
              {shown.visible.map((i, n) => (
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
        </div>
      )}
      <ShowMoreButtons
        hasMore={shown.hasMore}
        canCollapse={shown.canCollapse}
        loading={logs.isFetchingNextPage}
        onMore={shown.more}
        onCollapse={shown.collapse}
      />
    </section>
  );
}
