'use client';

import { useEffect } from 'react';
import type { OverlayRequest } from './NewRequestOverlay';

// 알림이 저절로 사라지기까지 (메신저 알림처럼 잠깐 떴다가 사라진다)
export const TOAST_MS = 8000;

// 새 요청 작은 알림 1개. 누르면 그 요청 상세를 연다
function Toast({
  request,
  onOpen,
  onClose,
}: {
  request: OverlayRequest;
  onOpen: (id: number) => void;
  onClose: (id: number) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onClose(request.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [request.id, onClose]);

  const detail = [
    request.chiefComplaint,
    request.etaMin !== null ? `도착 약 ${request.etaMin}분` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="toast-in pointer-events-auto flex items-start gap-3 rounded-[14px] border border-line bg-card px-4 py-3 shadow-[0_8px_24px_rgb(0_0_0/0.14)]">
      <span
        aria-hidden
        className="mt-[3px] flex size-[34px] shrink-0 items-center justify-center rounded-full bg-destructive text-[17px] text-white"
      >
        🚑
      </span>
      <button
        type="button"
        aria-label={`새 이송 요청 ${request.label}${detail ? ` · ${detail}` : ''} 열기`}
        onClick={() => {
          onOpen(request.id);
          onClose(request.id);
        }}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="flex w-full items-center gap-2">
          <span className="text-[16px] font-extrabold">새 이송 요청</span>
          <span className="ml-auto text-[13px] text-muted-foreground">지금</span>
        </span>
        <span className="w-full truncate text-[15px]">
          <span className="font-bold">{request.label}</span>
          {detail && <span className="text-muted-foreground"> · {detail}</span>}
        </span>
      </button>
      <button
        type="button"
        aria-label={`${request.label} 알림 닫기`}
        onClick={() => onClose(request.id)}
        className="-mr-1 rounded-md px-1.5 text-[18px] leading-none text-muted-foreground hover:bg-surface"
      >
        ×
      </button>
    </li>
  );
}

// 새 이송 요청이 오면 화면 오른쪽 위에 작게 뜨는 알림 (메신저 새 메시지 알림처럼).
// 소리는 내지 않는다. 환자를 알아볼 정보(이름 등)는 원래 없고, 요청 번호·주 증상·도착 예상만 보여준다
export function NewRequestToasts({
  toasts,
  onOpen,
  onClose,
}: {
  toasts: OverlayRequest[];
  onOpen: (id: number) => void;
  onClose: (id: number) => void;
}) {
  return (
    <ul
      aria-label="새 요청 알림"
      aria-live="polite"
      className="pointer-events-none fixed top-[16px] right-[24px] z-50 flex w-[min(380px,calc(100vw-48px))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast key={t.id} request={t} onOpen={onOpen} onClose={onClose} />
      ))}
    </ul>
  );
}
