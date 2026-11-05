'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { cn } from '@/lib/utils';
import { useAdminApi } from '../useAdminApi';

type NotificationList =
  ApiPaths['/admin/notifications']['get']['responses'][200]['content']['application/json'];

const NOTIFICATIONS_KEY = ['admin', 'notifications'] as const;
// 상단 개수는 1분마다 새로 묻는다. 새 알림을 실시간으로 밀어 주지는 않는다 (관리자 화면은 급하지 않음)
export const UNREAD_REFRESH_MS = 60_000;

const timeText = (iso: string) => new Date(iso).toLocaleString('ko-KR');

// 상단 바 '알림 N' (SFR-100). 누르면 모니터링 화면의 알림 목록으로 간다
export function UnreadBadge() {
  const api = useAdminApi();
  const unread = useQuery({
    queryKey: [...NOTIFICATIONS_KEY, 'unread'],
    queryFn: () => api<NotificationList>('/admin/notifications?limit=1'),
    select: (d) => d.unread ?? 0,
    refetchInterval: UNREAD_REFRESH_MS,
  });
  const n = unread.data ?? 0;
  return (
    <Link
      href="/admin/monitoring#notifications"
      aria-label={`읽지 않은 알림 ${n}개`}
      className={cn(
        'rounded-lg border-2 px-3 py-1 text-lg font-bold tabular-nums',
        n > 0 ? 'border-destructive bg-destructive text-white' : 'border-input',
      )}
    >
      알림 {n}
    </Link>
  );
}

// 관리자 알림 목록 (SFR-100, A-02). 최근 발생 순. 알림을 열면(누르면) 읽음으로 바뀐다
export function Notifications() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: [...NOTIFICATIONS_KEY, 'list'],
    queryFn: ({ pageParam }) =>
      api<NotificationList>(
        `/admin/notifications?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const read = useMutation({
    mutationFn: (id: number) => api(`/admin/notifications/${id}/read`, { method: 'POST' }),
    // 목록과 상단 개수를 함께 새로 받는다
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  const items = list.data?.pages.flatMap((p) => p.items ?? []) ?? [];

  return (
    <section
      id="notifications"
      aria-labelledby="notifications-title"
      className="flex flex-col gap-4"
    >
      <h2 id="notifications-title" className="text-2xl font-bold">
        관리자 알림
      </h2>
      {(list.isError || read.isError) && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(list.error ?? read.error)}
        </p>
      )}
      {list.isSuccess && items.length === 0 && (
        <p className="text-lg text-muted-foreground">알림이 없어요.</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => !i.read && i.id !== undefined && read.mutate(i.id)}
                aria-label={`${i.text}${i.read ? '' : ' (안 읽음)'}`}
                className={cn(
                  'flex w-full items-center justify-between gap-4 rounded-lg border-2 px-4 py-3 text-left text-lg',
                  i.read ? 'border-input text-muted-foreground' : 'border-foreground font-bold',
                )}
              >
                <span>
                  {!i.read && <span aria-hidden>● </span>}
                  {i.text}
                  {(i.occurrences ?? 1) > 1 && (
                    <span className="ml-2 tabular-nums">· {i.occurrences}회</span>
                  )}
                </span>
                <span className="text-base font-normal tabular-nums">
                  {i.lastAt ? timeText(i.lastAt) : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          size="lg"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? '불러오는 중…' : '알림 더 보기'}
        </Button>
      )}
    </section>
  );
}
