'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { cn } from '@/lib/utils';
import { ExpandableBox } from '../ExpandableBox';
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
        'rounded-full border px-3.5 py-1.5 text-sm font-extrabold tabular-nums transition',
        n > 0
          ? 'btn-solid-brand border-transparent text-white'
          : 'border-border-strong bg-card text-muted-foreground hover:bg-surface',
      )}
    >
      알림 {n}
    </Link>
  );
}

type NotificationItem = NonNullable<NotificationList['items']>[number];

// 알림을 누르면 갈 화면. 가입 신청 → 그 신청 창, PC·키 알림 → 병원 관리에서 그 병원.
// 병상 수집·호출 한도·정합성 알림은 따로 볼 화면이 없어 읽음 처리만 한다
export function notificationHref(i: NotificationItem): string | null {
  if (i.kind === 'signup' && i.refId != null) return `/admin/accounts?signup=${i.refId}`;
  if ((i.kind === 'pc_change' || i.kind === 'odd_pc') && i.hospitalName) {
    return `/admin/hospitals?q=${encodeURIComponent(i.hospitalName)}&pcs=1`;
  }
  if (i.kind === 'key_expiring' && i.hospitalName) {
    return `/admin/hospitals?q=${encodeURIComponent(i.hospitalName)}`;
  }
  return null;
}

// 관리자 알림 목록 (SFR-100, A-02). 최근 발생 순, 상자 안에서 스크롤하고 끝에 닿으면 다음 쪽을 받는다.
// 알림을 누르면 읽음으로 바꾸고 해당 화면으로 간다. unreadOnly: 첫 화면처럼 안 읽은 알림만
export function Notifications({
  title = '관리자 알림',
  unreadOnly = false,
}: {
  title?: string;
  unreadOnly?: boolean;
}) {
  const api = useAdminApi();
  const router = useRouter();
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

  const all = list.data?.pages.flatMap((p) => p.items ?? []) ?? [];
  const items = unreadOnly ? all.filter((i) => !i.read) : all;
  const titleId = unreadOnly ? 'new-notifications-title' : 'notifications-title';

  function open(i: NotificationItem) {
    if (!i.read && i.id !== undefined) read.mutate(i.id);
    const href = notificationHref(i);
    if (href) router.push(href);
  }

  // 스크롤이 끝에 가까워지면 다음 쪽 (30개씩)
  function loadMore() {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }

  return (
    <section
      id={unreadOnly ? undefined : 'notifications'}
      aria-labelledby={titleId}
      className="panel"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="section-title panel-title">
          {title}
          {unreadOnly && items.length > 0 && (
            <span className="ml-2 rounded-full bg-destructive px-2.5 py-0.5 text-sm font-bold text-white tabular-nums">
              {items.length}
            </span>
          )}
        </h2>
        {/* 새로고침: 받는 동안 화살표가 돌고, 다 받으면 멈춘다 */}
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 rounded-[10px] px-3 text-[15px] font-semibold"
          aria-label="알림 새로고침"
          disabled={list.isFetching}
          onClick={() => void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY })}
        >
          <RefreshCw
            aria-hidden
            data-spinning={list.isFetching || undefined}
            className={cn('size-4', list.isFetching && 'animate-spin')}
          />
          새로고침
        </Button>
      </div>
      {(list.isError || read.isError) && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(list.error ?? read.error)}
        </p>
      )}
      {list.isSuccess && items.length === 0 && (
        <p className="well px-5 py-6 text-center text-base text-muted-foreground">
          {unreadOnly ? '새 알림이 없어요.' : '알림이 없어요.'}
        </p>
      )}
      {items.length > 0 && (
        <ExpandableBox
          title={title}
          label={unreadOnly ? '새 알림 더 보기' : '알림 더 보기'}
          showMore={items.length > 4 || !!list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onScrollEnd={loadMore}
          boxClassName="max-h-[330px]"
        >
          {() => (
            <ul className="flex flex-col gap-2">
              {items.map((i) => {
                const href = notificationHref(i);
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => open(i)}
                      aria-label={`${i.text}${i.read ? '' : ' (안 읽음)'}${href ? ' · 열기' : ''}`}
                      className={cn(
                        'flex w-full items-center justify-between gap-4 rounded-xl border px-4 py-3.5 text-left text-base transition',
                        i.read
                          ? 'border-border bg-surface/60 text-muted-foreground hover:bg-surface'
                          : 'border-brand/40 bg-brand-soft/45 font-bold text-foreground hover:bg-brand-soft/75',
                      )}
                    >
                      <span>
                        {!i.read && <span aria-hidden>● </span>}
                        {i.text}
                        {(i.occurrences ?? 1) > 1 && (
                          <span className="ml-2 tabular-nums">· {i.occurrences}회</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-base font-normal tabular-nums">
                        {i.lastAt ? timeText(i.lastAt) : ''}
                        {href && <ChevronRight aria-hidden className="size-4" />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ExpandableBox>
      )}
      {unreadOnly && (
        <Link
          href="/admin/monitoring#notifications"
          className="w-fit text-[15px] font-semibold text-info-strong hover:underline"
        >
          모든 알림 보기 →
        </Link>
      )}
    </section>
  );
}
