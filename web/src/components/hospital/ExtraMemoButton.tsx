'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { ExtraMemoDialog } from './ExtraMemoDialog';

function extraMemoErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return errorText(error);
  switch (error.code) {
    case 'EXTRA_MEMO_USED':
      return '추가 메모는 이미 보냈어요 (한 번만 보낼 수 있어요)';
    case 'REQUEST_CLOSED':
      return '이미 끝난 요청이에요';
    case 'VERSION_CONFLICT':
    case 'INVALID_TRANSITION':
      return '그사이 요청 상태가 바뀌었어요. 최신 상태로 다시 보여 드릴게요';
    default:
      return errorText(error);
  }
}

// 상태가 바뀌어 막힌 거면 창을 닫고 목록·상세를 다시 받아 지금 상태(버튼 없음 등)를 보여 준다
const STALE_CODES = new Set([
  'EXTRA_MEMO_USED',
  'REQUEST_CLOSED',
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
]);

type Props = {
  requestId: number;
  // 화면에 보여 준 요청의 version. 그사이 바뀌었으면 서버가 막는다 (SFR-160)
  version: number;
  // 이미 보냈으면 버튼은 숨기고, 방금 막힌 이유(다른 PC 가 먼저 보냄 등)만 남긴다
  used: boolean;
  className?: string;
};

// '추가 메모' 버튼 + 쓰기 창 (SFR-140). 우리 병원으로 확정된 요청에 한 번만.
// 요청 상세(H-02)와 도착 예정 목록(H-03) 두 곳에서 같은 걸 쓴다
export function ExtraMemoButton({ requestId, version, used, className }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // 빠르게 두 번 눌러도 한 번만 보낸다
  const sending = useRef(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
    void queryClient.invalidateQueries({ queryKey: ['hw', 'incoming'] });
  };

  const send = useMutation({
    mutationFn: (memo: string) =>
      apiFetch(`/hw/requests/${requestId}/extra-memo`, {
        method: 'POST',
        body: JSON.stringify({ memo, version }),
      }),
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: () => {
      setOpen(false);
      refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && STALE_CODES.has(error.code)) {
        setOpen(false);
        refresh();
      }
    },
  });

  return (
    <div className="flex flex-col gap-2">
      {send.isError && !open && (
        <p role="alert" className="text-xl font-bold text-destructive">
          {extraMemoErrorText(send.error)}
        </p>
      )}
      {!used && (
        <Button
          size="lg"
          variant="outline"
          className={className ?? 'h-14 w-fit border-2 text-xl'}
          disabled={send.isPending}
          onClick={() => {
            send.reset();
            setOpen(true);
          }}
        >
          추가 메모
        </Button>
      )}
      <ExtraMemoDialog
        key={open ? 'open' : 'closed'}
        open={open}
        pending={send.isPending}
        error={send.isError ? extraMemoErrorText(send.error) : null}
        onSubmit={(memo) => {
          if (sending.current) return;
          sending.current = true;
          send.mutate(memo);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
