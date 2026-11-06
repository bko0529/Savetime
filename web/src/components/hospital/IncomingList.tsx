'use client';

import { Button } from '@/components/ui/button';
import type { HwIncoming, RemovedNotice, RemovedReason } from '@/app/hospital/useIncoming';
import { ExtraMemoButton } from './ExtraMemoButton';

const STATUS_TEXT: Record<string, string> = {
  confirmed: '이동 중',
  arrived: '도착',
  unacceptable: '수용 불가',
};

const REMOVED_TEXT: Record<RemovedReason, string> = {
  cancelled: '이송이 취소됐어요',
  dest_changed: '목적지가 다른 병원으로 바뀌었어요',
  approval_cancelled: '승인을 취소해서 도착 예정에서 빠졌어요',
};

// '14:05 도착' (PC 시각대로 보여 준다. 판정이 아니라 표시만)
function arrivedText(arrivedAt: string): string {
  const d = new Date(arrivedAt);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 도착`;
}

function etaText(item: HwIncoming): string {
  if (item.status === 'arrived' || item.status === 'unacceptable') {
    return item.arrivedAt ? arrivedText(item.arrivedAt) : '—';
  }
  return item.etaMin != null ? `도착 예상 ${item.etaMin}분` : '계산 중';
}

type Props = {
  items: HwIncoming[];
  notices: RemovedNotice[];
  onDismiss: (requestId: number) => void;
};

// 도착 예정 목록 (SFR-121, H-03). 구급차 위치·지도는 보여 주지 않고 도착 예상 시간만 (D-71)
export function IncomingList({ items, notices, onDismiss }: Props) {
  return (
    <div className="flex flex-col gap-4">
      {notices.map((n) => (
        <div
          key={n.requestId}
          role="alert"
          className="flex items-center justify-between gap-4 rounded-lg border-2 border-destructive px-4 py-3 text-xl font-bold text-destructive"
        >
          <span>
            R-{n.requestId} {REMOVED_TEXT[n.reason]}
          </span>
          <Button variant="outline" size="lg" onClick={() => onDismiss(n.requestId)}>
            확인
          </Button>
        </div>
      ))}
      {items.length === 0 ? (
        <p className="text-xl text-muted-foreground">도착 예정 환자가 없어요.</p>
      ) : (
        <table className="w-full border-collapse text-xl">
          <thead>
            <tr className="border-b-2 border-foreground text-left">
              <th className="p-3">번호</th>
              <th className="p-3">환자</th>
              <th className="p-3">상태</th>
              <th className="p-3">도착</th>
              <th className="p-3">
                <span className="sr-only">할 일</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b">
                <td className="p-3 font-bold">{item.label}</td>
                {/* 요약은 도착 후 1시간까지만 서버가 준다 (SER-014). 없으면 비워 둔다 */}
                <td className="p-3">{item.summary ?? '—'}</td>
                <td className="p-3">{STATUS_TEXT[item.status ?? ''] ?? item.status}</td>
                <td className="p-3 tabular-nums">{etaText(item)}</td>
                <td className="p-3">
                  {/* 이동 중인 환자에게만 추가 메모 1번 (SFR-140) */}
                  {item.status === 'confirmed' && item.id != null && (
                    <ExtraMemoButton
                      requestId={item.id}
                      version={item.version ?? 1}
                      used={!!item.extraMemoUsed}
                      className="h-12 border-2 text-lg"
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
