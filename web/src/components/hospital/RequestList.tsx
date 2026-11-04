'use client';

import type { components } from '@/lib/api/schema';
import { isUrgent, remainingText } from '@/lib/assessment/labels';
import { cn } from '@/lib/utils';

export type HwRequestItem = components['schemas']['HwRequestItem'];

const STATUS_TEXT: Record<string, string> = {
  waiting: '응답 대기',
  approved: '승인',
};

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
    return <p className="text-xl text-muted-foreground">지금 응답할 요청이 없어요.</p>;
  }
  return (
    <table className="w-full border-collapse text-xl">
      <thead>
        <tr className="border-b-2 border-foreground text-left">
          <th className="p-3">번호</th>
          <th className="p-3">주 증상</th>
          <th className="p-3">이상 수치</th>
          <th className="p-3">도착 예상</th>
          <th className="p-3">상태</th>
          <th className="p-3">남은 시간</th>
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
              className={cn('border-b', selectedId === id && 'bg-accent')}
              aria-selected={selectedId === id}
            >
              <td className="p-3">
                {/* 행 전체가 아니라 버튼을 둬야 키보드(Tab·Enter)로도 열 수 있다 */}
                <button
                  type="button"
                  className="font-bold underline underline-offset-4"
                  onClick={() => onOpen(id)}
                >
                  {item.label}
                </button>
              </td>
              <td className="p-3">{item.chiefComplaint ?? '—'}</td>
              <td className="p-3">
                {item.abnormalCount ? (
                  <span className="font-bold text-destructive">⚠ 이상 {item.abnormalCount}</span>
                ) : (
                  '—'
                )}
              </td>
              <td className="p-3">
                {item.etaMin != null
                  ? `${item.etaSource === 'straight' ? '약 ' : ''}${item.etaMin}분`
                  : '—'}
              </td>
              <td className="p-3">
                {STATUS_TEXT[item.status ?? ''] ?? item.status}
                {item.respondedBy ? ` · ${item.respondedBy}` : ''}
              </td>
              <td className={cn('p-3 tabular-nums', urgent && 'font-extrabold text-destructive')}>
                {waiting && item.respondUntil ? remainingText(item.respondUntil, nowMs) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
