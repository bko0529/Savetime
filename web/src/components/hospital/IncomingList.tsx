'use client';

import { Button } from '@/components/ui/button';
import type { HwIncoming, RemovedNotice, RemovedReason } from '@/app/hospital/useIncoming';
import { cn } from '@/lib/utils';
import { Chip, type Tone } from './Chip';
import { table } from './tableStyles';
import { ConfirmArrivalButton } from './ConfirmArrivalButton';
import { ExtraMemoButton } from './ExtraMemoButton';
import { UnacceptableButton } from './UnacceptableButton';

const STATUS_TEXT: Record<string, string> = {
  confirmed: '이동 중',
  arrived: '도착',
  unacceptable: '수용 불가',
};

const STATUS_TONE: Record<string, Tone> = {
  confirmed: 'info',
  arrived: 'neutral',
  unacceptable: 'danger',
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

// 도착 예정 목록과 요청 상세가 같은 문구를 쓴다 (확정 뒤에는 이 목록 값이 최신이다)
export function etaText(item: HwIncoming): string {
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
    <div className="flex flex-col">
      {notices.map((n) => (
        <div
          key={n.requestId}
          role="alert"
          className="mx-6 mb-4 flex items-center justify-between gap-4 rounded-[12px] border border-danger-line bg-danger-soft px-4 py-3 text-[19px] font-bold text-danger-strong"
        >
          <span>
            R-{n.requestId} {REMOVED_TEXT[n.reason]}
          </span>
          <Button
            variant="outline"
            className="rounded-[10px] bg-card text-foreground"
            onClick={() => onDismiss(n.requestId)}
          >
            확인
          </Button>
        </div>
      ))}
      {items.length === 0 ? (
        <p className={table.empty}>도착 예정 환자가 없어요.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={table.root}>
            <thead>
              <tr className={table.headRow}>
                <th className={table.th}>번호</th>
                <th className={table.th}>환자</th>
                <th className={table.th}>상태</th>
                <th className={table.th}>도착</th>
                <th className={table.th}>
                  <span className="sr-only">할 일</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={table.row}>
                  <td className={cn(table.td, 'font-extrabold whitespace-nowrap tabular-nums')}>
                    {item.label}
                  </td>
                  {/* 요약은 도착 후 1시간까지만 서버가 준다 (SER-014). 없으면 비워 둔다 */}
                  <td className={cn(table.td, 'break-words')}>{item.summary ?? '—'}</td>
                  <td className={table.td}>
                    <Chip tone={STATUS_TONE[item.status ?? ''] ?? 'neutral'}>
                      {STATUS_TEXT[item.status ?? ''] ?? item.status}
                    </Chip>
                  </td>
                  <td className={cn(table.td, 'font-bold whitespace-nowrap tabular-nums')}>
                    {etaText(item)}
                  </td>
                  <td className={table.td}>
                    {/* 이동 중인 환자에게만: 도착 확인(SFR-144) · 추가 메모 1번(SFR-140).
                      이미 도착한 환자는 버튼 없이 '도착'으로만 보인다 */}
                    {item.status === 'confirmed' && item.id != null && (
                      <div className="flex flex-wrap items-start gap-3">
                        <ConfirmArrivalButton
                          requestId={item.id}
                          version={item.version ?? 1}
                          enabled={!!item.canConfirmArrival}
                        />
                        <ExtraMemoButton
                          requestId={item.id}
                          version={item.version ?? 1}
                          used={!!item.extraMemoUsed}
                          className="h-[52px] rounded-[10px] border-2 px-5 text-lg"
                        />
                      </div>
                    )}
                    {/* 도착한 지 10분 안의 환자에게만 수용 불가 (SFR-158). 10분 판정은 서버가 한다 */}
                    {item.status === 'arrived' && item.canMarkUnacceptable && item.id != null && (
                      <UnacceptableButton requestId={item.id} version={item.version ?? 1} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
