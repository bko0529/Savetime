'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// API HwRequestItem 중 덮개 알림에 필요한 필드만. 구급대 소속은 API에도 없고 여기서도 보여주지 않는다 (D-98).
export type OverlayRequest = {
  id: number;
  label: string;
  chiefComplaint: string | null;
  etaMin: number | null;
  respondUntil: string;
};

type Props = {
  /** 아직 '확인'을 누르지 않은 요청 중 맨 앞 1건. 없으면 창이 닫힌다 */
  request: OverlayRequest | null;
  /** 응답 대기 중인 요청 전체 건수 */
  pendingCount: number;
  /** 지금 시각(ms). S3부터는 서버 시각(X-Server-Now)으로 보정한 값을 넘긴다 */
  nowMs: number;
  onConfirm: (id: number) => void;
};

const cellClass =
  'flex min-h-[110px] items-center justify-center rounded-[14px] bg-overlay-cell px-5 py-4 text-[36px] leading-tight font-extrabold break-words';

export function formatRemaining(respondUntil: string, nowMs: number): string {
  const sec = Math.max(0, Math.floor((Date.parse(respondUntil) - nowMs) / 1000));
  return `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초`;
}

// 새 요청 덮개 알림 창 (SFR-117, D-114).
// 열림·닫힘을 부모가 넘긴 request 로만 정한다. '확인'을 누르거나 요청이 끝나서 request 가 null 이 될 때만 닫힌다.
// Base UI 는 Esc·바깥 클릭에 스스로 닫는 동작을 시작하므로, 무시하는 것만으로는 안 되고 cancel() 로 막아야 한다.
export function NewRequestOverlay({ request, pendingCount, nowMs, onConfirm }: Props) {
  return (
    <Dialog
      open={request !== null}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (!open) details.cancel();
      }}
    >
      {request && (
        <DialogContent
          showCloseButton={false}
          overlayClassName="bg-foreground/60"
          className="flex h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-none flex-col items-center justify-center-safe gap-10 overflow-y-auto rounded-[20px] bg-destructive p-10 text-center text-white ring-0 sm:max-w-none"
        >
          <DialogTitle className="flex flex-col items-center gap-5 text-[64px] leading-tight font-extrabold tracking-[-0.02em]">
            {pendingCount > 1 && (
              <span className="rounded-full bg-white/20 px-5 py-2 text-[24px] tracking-normal">
                대기 {pendingCount}건
              </span>
            )}
            🔴 새 이송 요청
          </DialogTitle>
          <DialogDescription
            render={<div />}
            className="grid w-full max-w-[960px] gap-3 text-white tabular-nums sm:grid-cols-2"
          >
            <p className={cellClass}>{request.label}</p>
            <p className={cellClass}>{request.chiefComplaint ?? '주 증상 정보 없음'}</p>
            <p className={cellClass}>
              도착 예상 {request.etaMin === null ? '계산 중' : `${request.etaMin}분`}
            </p>
            <p className={cellClass}>
              응답 남은 시간 {formatRemaining(request.respondUntil, nowMs)}
            </p>
          </DialogDescription>
          <Button
            size="lg"
            autoFocus
            // bg-none: 기본 버튼의 검정 그라데이션이 흰 바탕을 덮지 않게
            className="h-[88px] min-w-[300px] rounded-[12px] bg-white bg-none text-[34px] font-extrabold text-destructive shadow-none hover:bg-white/90"
            onClick={() => onConfirm(request.id)}
          >
            확인
          </Button>
        </DialogContent>
      )}
    </Dialog>
  );
}
