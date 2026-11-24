'use client';

import type { components } from '@/lib/api/schema';
import { isUrgent, remainingText } from '@/lib/assessment/labels';
import { cn } from '@/lib/utils';
import { Chip, type Tone } from './Chip';

export type HwRequestItem = components['schemas']['HwRequestItem'];

const STATUS_TEXT: Record<string, string> = {
  waiting: '응답 대기',
  approved: '승인',
};
const STATUS_TONE: Record<string, Tone> = { waiting: 'warning', approved: 'success' };

// 응답 2분 중 남은 비율. 막대를 그리는 데만 쓴다 (시간 판정은 서버, 규칙 6)
const RESPOND_WINDOW_MS = 2 * 60 * 1000;
function remainingPercent(respondUntil: string, nowMs: number): number {
  const ratio = (Date.parse(respondUntil) - nowMs) / RESPOND_WINDOW_MS;
  return Math.min(100, Math.max(0, ratio * 100));
}

type Props = {
  items: HwRequestItem[];
  nowMs: number;
  selectedId: number | null;
  onOpen: (id: number) => void;
};

// 요청 목록 (SFR-135). 서버가 남은 시간 짧은 순으로 준다 — 이상 수치로 순서를 바꾸지 않는다 (SFR-155, D-38).
// 구급대 소속은 API 에도 없고 여기서도 보여 주지 않는다 (D-98). 화면 왼쪽 세로 카드 목록 (시안 2026-11-24)
export function RequestList({ items, nowMs, selectedId, onOpen }: Props) {
  if (items.length === 0) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed border-line bg-card px-5 py-10 text-center">
        <p className="text-[20px] font-bold">지금 응답할 요청이 없어요</p>
        <p className="text-[16px] text-muted-foreground">
          구급대원이 요청을 보내면 여기에 카드로 쌓이고, 알림음이 울려요.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const id = item.id!;
        const waiting = item.status === 'waiting';
        const urgent = waiting && item.respondUntil && isUrgent(item.respondUntil, nowMs);
        const selected = selectedId === id;
        return (
          <li key={id}>
            {/* 카드 전체를 버튼으로: 키보드(Tab·Enter)로도 연다 */}
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onOpen(id)}
              className={cn(
                'flex w-full flex-col gap-3 rounded-[16px] border-2 bg-card px-5 py-4 text-left shadow-[0_4px_16px_rgba(15,23,42,0.06)] transition',
                selected ? 'border-foreground' : 'border-transparent hover:border-line',
              )}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 text-[18px] font-extrabold break-words">
                  <span className="tabular-nums">{item.label}</span>
                  {item.chiefComplaint ? ` · ${item.chiefComplaint}` : ''}
                </span>
                {waiting && item.respondUntil ? (
                  <span
                    className={cn(
                      'shrink-0 text-[24px] font-extrabold tabular-nums',
                      urgent && 'text-destructive',
                    )}
                  >
                    {remainingText(item.respondUntil, nowMs)}
                  </span>
                ) : (
                  <Chip tone={STATUS_TONE[item.status ?? ''] ?? 'neutral'}>
                    {STATUS_TEXT[item.status ?? ''] ?? item.status}
                    {item.respondedBy ? ` · ${item.respondedBy}` : ''}
                  </Chip>
                )}
              </span>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[15px] text-muted-foreground tabular-nums">
                  {item.etaMin != null
                    ? `도착 예상 ${item.etaSource === 'straight' ? '약 ' : ''}${item.etaMin}분`
                    : '도착 예상 —'}
                </span>
                {item.abnormalCount ? (
                  <Chip
                    tone="danger"
                    className="rounded-full border border-danger-line text-[14px] font-extrabold"
                  >
                    ⚠ 이상 {item.abnormalCount}
                  </Chip>
                ) : null}
              </span>
              {waiting && item.respondUntil && (
                <span aria-hidden className="h-[4px] overflow-hidden rounded-full bg-line-soft">
                  <span
                    className={cn('block h-full', urgent ? 'bg-destructive' : 'bg-foreground')}
                    style={{ width: `${remainingPercent(item.respondUntil, nowMs)}%` }}
                  />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
