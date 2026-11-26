'use client';

import { Maximize2 } from 'lucide-react';
import { useState, type ReactNode, type UIEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// 관리자 목록 공통 모양: 화면에는 낮은 상자(스크롤), '더 보기'를 누르면 큰 창에 전체 목록(스크롤).
// 둘 다 끝까지 내리면 onScrollEnd 로 다음 쪽을 받는다. children 은 (큰 창인지) => 목록
export function ExpandableBox({
  title,
  label = '더 보기',
  showMore,
  loadingMore = false,
  onScrollEnd,
  boxClassName = 'max-h-[320px]',
  children,
}: {
  title: string;
  label?: string;
  // 항목이 적어 낮은 상자에 다 들어가면 버튼을 숨긴다
  showMore: boolean;
  loadingMore?: boolean;
  onScrollEnd?: () => void;
  boxClassName?: string;
  children: (expanded: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) onScrollEnd?.();
  }

  const loading = loadingMore && (
    <p className="py-3 text-center text-sm text-muted-foreground">불러오는 중…</p>
  );

  return (
    <>
      <div
        onScroll={onScroll}
        className={cn('overflow-y-auto pr-1', boxClassName)}
        data-testid={`${title} 상자`}
      >
        {children(false)}
        {loading}
      </div>
      {showMore && (
        <Button
          variant="outline"
          size="sm"
          className="h-9 w-fit gap-1.5 rounded-[10px] px-3 text-[15px] font-semibold"
          aria-label={`${title} ${label}`}
          onClick={() => setOpen(true)}
        >
          <Maximize2 aria-hidden className="size-4" />
          {label}
        </Button>
      )}
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 p-6 sm:max-w-6xl">
            <DialogTitle className="text-2xl font-extrabold">{title}</DialogTitle>
            <DialogDescription className="sr-only">{title} 전체 목록</DialogDescription>
            <div
              onScroll={onScroll}
              className="min-h-0 flex-1 overflow-y-auto pr-1"
              data-testid={`${title} 큰 창`}
            >
              {children(true)}
              {loading}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
