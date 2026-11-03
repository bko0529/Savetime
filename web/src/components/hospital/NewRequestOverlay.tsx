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
          className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col items-center justify-center gap-8 bg-destructive p-10 text-center text-white ring-0 sm:max-w-none"
        >
          <DialogTitle className="text-5xl leading-tight font-extrabold">
            🔴 새 이송 요청
            {pendingCount > 1 && <span className="mt-4 block text-4xl">대기 {pendingCount}건</span>}
          </DialogTitle>
          <DialogDescription render={<div />} className="space-y-3 text-3xl text-white">
            <p className="font-bold">{request.label}</p>
            <p>{request.chiefComplaint ?? '주 증상 정보 없음'}</p>
            <p>도착 예상 {request.etaMin === null ? '계산 중' : `${request.etaMin}분`}</p>
            <p>응답 남은 시간 {formatRemaining(request.respondUntil, nowMs)}</p>
          </DialogDescription>
          <Button
            size="lg"
            autoFocus
            className="h-20 min-w-64 bg-white text-3xl text-destructive hover:bg-white/90"
            onClick={() => onConfirm(request.id)}
          >
            확인
          </Button>
        </DialogContent>
      )}
    </Dialog>
  );
}
