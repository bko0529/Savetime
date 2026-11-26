'use client';

import type { components } from '@/lib/api/schema';
import { isUrgent, remainingText } from '@/lib/assessment/labels';
import { cn } from '@/lib/utils';
import { Chip, type Tone } from './Chip';
import { table } from './tableStyles';

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
// 구급대 소속은 API 에도 없고 여기서도 보여 주지 않는다 (D-98)
export function RequestList({ items, nowMs, selectedId, onOpen }: Props) {
  if (items.length === 0) {
    return <p className={table.empty}>지금 응답할 요청이 없어요.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className={table.root}>
        <thead>
          <tr className={table.headRow}>
            <th className={table.th}>번호</th>
            <th className={table.th}>주 증상</th>
            <th className={table.th}>이상 수치</th>
            <th className={table.th}>도착 예상</th>
            <th className={table.th}>상태</th>
            <th className={table.th}>남은 시간</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const id = item.id!;
            const waiting = item.status === 'waiting';
            const urgent = waiting && item.respondUntil && isUrgent(item.respondUntil, nowMs);
            return (
              <tr
                key={id}
                // 줄 어디를 눌러도 상세가 열린다 (번호 글자만 누르기는 작아서 어렵다).
                // 키보드(Tab·Enter)는 아래 번호 버튼으로 연다
                onClick={() => onOpen(id)}
                className={cn(
                  table.row,
                  'cursor-pointer hover:bg-surface',
                  selectedId === id && 'bg-selected shadow-[inset_4px_0_0_var(--foreground)]',
                  urgent && 'bg-urgent shadow-[inset_4px_0_0_var(--destructive)]',
                )}
                aria-selected={selectedId === id}
              >
                <td className={cn(table.td, 'whitespace-nowrap')}>
                  {/* 행 전체가 아니라 버튼을 둬야 키보드(Tab·Enter)로도 열 수 있다 */}
                  <button
                    type="button"
                    className="font-extrabold tabular-nums underline underline-offset-4"
                    // 줄의 onClick 과 두 번 열리지 않게 여기서 멈춘다
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(id);
                    }}
                  >
                    {item.label}
                  </button>
                </td>
                <td className={cn(table.td, 'min-w-[96px] break-words')}>
                  {item.chiefComplaint ?? '—'}
                </td>
                <td className={table.td}>
                  {item.abnormalCount ? (
                    <Chip tone="danger" className="rounded-[8px] text-[17px] font-extrabold">
                      ⚠ 이상 {item.abnormalCount}
                    </Chip>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={cn(table.td, 'whitespace-nowrap tabular-nums')}>
                  {item.etaMin != null
                    ? `${item.etaSource === 'straight' ? '약 ' : ''}${item.etaMin}분`
                    : '—'}
                </td>
                <td className={table.td}>
                  <Chip tone={STATUS_TONE[item.status ?? ''] ?? 'neutral'}>
                    {STATUS_TEXT[item.status ?? ''] ?? item.status}
                    {item.respondedBy ? ` · ${item.respondedBy}` : ''}
                  </Chip>
                </td>
                <td className={cn(table.td, 'min-w-[96px]')}>
                  {waiting && item.respondUntil ? (
                    <>
                      <span
                        className={cn(
                          'text-[22px] font-bold tabular-nums',
                          urgent && 'font-extrabold text-destructive',
                        )}
                      >
                        {remainingText(item.respondUntil, nowMs)}
                      </span>
                      <div
                        aria-hidden
                        className="mt-1 h-[5px] overflow-hidden rounded-full bg-line-soft"
                      >
                        <div
                          className={cn('h-full', urgent ? 'bg-destructive' : 'bg-foreground')}
                          style={{ width: `${remainingPercent(item.respondUntil, nowMs)}%` }}
                        />
                      </div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
