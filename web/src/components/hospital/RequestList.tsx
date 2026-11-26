'use client';

import type { components } from '@/lib/api/schema';
import { isUrgent, remainingText } from '@/lib/assessment/labels';
import { cn } from '@/lib/utils';
import { Chip } from './Chip';

export type HwRequestItem = components['schemas']['HwRequestItem'];

type Props = {
  items: HwRequestItem[];
  nowMs: number;
  selectedId: number | null;
  onOpen: (id: number) => void;
};

function etaText(item: HwRequestItem): string | null {
  if (item.etaMin == null) return null;
  return `도착 예상 ${item.etaSource === 'straight' ? '약 ' : ''}${item.etaMin}분`;
}

// 요청 목록 (SFR-135): 요청 하나를 카드 하나로. 서버가 남은 시간 짧은 순으로 준다 —
// 이상 수치로 순서를 바꾸지 않는다 (SFR-155, D-38). 구급대 소속은 API 에도 없고 여기서도 보여 주지 않는다 (D-98)
export function RequestList({ items, nowMs, selectedId, onOpen }: Props) {
  if (items.length === 0) {
    return (
      <p className="rounded-[16px] border border-line bg-card px-5 py-8 text-center text-[18px] text-muted-foreground">
        지금 응답할 요청이 없어요.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3" aria-label="요청 목록">
      {items.map((item) => {
        const id = item.id!;
        const waiting = item.status === 'waiting';
        const urgent = waiting && item.respondUntil && isUrgent(item.respondUntil, nowMs);
        const selected = selectedId === id;
        const eta = etaText(item);
        return (
          <li
            key={id}
            // 카드 어디를 눌러도 상세가 열린다. 키보드(Tab·Enter)는 아래 번호 버튼으로 연다
            onClick={() => onOpen(id)}
            aria-current={selected || undefined}
            className={cn(
              'flex cursor-pointer flex-col gap-2 rounded-[16px] border bg-card px-5 py-4 shadow-[var(--shadow-card)] transition-colors hover:border-border-strong',
              selected ? 'border-2 border-foreground' : 'border-line',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-[18px] font-extrabold break-words">
                <button
                  type="button"
                  className="font-extrabold tabular-nums focus-visible:underline"
                  // 카드의 onClick 과 두 번 열리지 않게 여기서 멈춘다
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(id);
                  }}
                >
                  {item.label}
                </button>
                {item.chiefComplaint ? ` · ${item.chiefComplaint}` : ''}
              </p>
              {waiting && item.respondUntil ? (
                <span
                  className={cn(
                    'shrink-0 text-[24px] leading-none font-extrabold tabular-nums',
                    urgent && 'text-destructive',
                  )}
                >
                  {remainingText(item.respondUntil, nowMs)}
                </span>
              ) : (
                <Chip tone="success" className="shrink-0">
                  승인{item.respondedBy ? ` · ${item.respondedBy}` : ''}
                </Chip>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[15px] text-muted-foreground">
                {eta ?? '도착 예상 정보 없음'}
              </span>
              {item.abnormalCount ? (
                <Chip tone="danger" className="border border-danger-line py-0.5 text-[15px]">
                  ⚠ 이상 {item.abnormalCount}
                </Chip>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
