'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
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

  return (
    <section aria-labelledby="audit-title" className="flex flex-col gap-4">
      <h2 id="audit-title" className="text-2xl font-bold">
        관리자 작업 이력
      </h2>
      {logs.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(logs.error)}
        </p>
      )}
      {logs.isSuccess && items.length === 0 && (
        <p className="text-lg text-muted-foreground">아직 기록된 작업이 없어요.</p>
      )}
      {items.length > 0 && (
        <table className="w-full border-collapse text-lg">
          <thead>
            <tr className="border-b-2 border-foreground text-left">
              <th className="p-3">시각</th>
              <th className="p-3">관리자</th>
              <th className="p-3">작업</th>
              <th className="p-3">대상</th>
              <th className="p-3">사유</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i, n) => (
              <tr key={`${i.at}-${n}`} className="border-b">
                <td className="p-3 tabular-nums">{i.at ? timeText(i.at) : '—'}</td>
                <td className="p-3">{i.admin}</td>
                <td className="p-3 font-bold">{i.action}</td>
                <td className="p-3">{i.target}</td>
                <td className="p-3">{i.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {logs.hasNextPage && (
        <Button
          variant="outline"
          size="lg"
          className="self-start"
          disabled={logs.isFetchingNextPage}
          onClick={() => void logs.fetchNextPage()}
        >
          {logs.isFetchingNextPage ? '불러오는 중…' : '더 보기'}
        </Button>
      )}
    </section>
  );
}
