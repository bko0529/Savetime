'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { RejectReasonDialog, type RejectBody } from './RejectReasonDialog';

function unacceptableErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return errorText(error);
  switch (error.code) {
    case 'WINDOW_PASSED':
      return '도착 후 10분이 지나 수용 불가로 돌릴 수 없어요';
    case 'VERSION_CONFLICT':
    case 'INVALID_TRANSITION':
      return '그사이 상태가 바뀌었어요. 최신 상태로 다시 보여 드릴게요';
    default:
      return errorText(error);
  }
}

// 상태가 바뀌어 막힌 거면 창을 닫고 목록을 다시 받아 지금 상태(버튼 없음 등)를 보여 준다
const STALE_CODES = new Set(['WINDOW_PASSED', 'VERSION_CONFLICT', 'INVALID_TRANSITION']);

type Props = {
  requestId: number;
  // 화면에 보여 준 요청의 version. 그사이 바뀌었으면 서버가 막는다 (SFR-160)
  version: number;
};

// 도착 예정 목록의 '수용 불가' (SFR-158, H-03). 도착 후 10분 안의 환자에게만 보인다(서버 canMarkUnacceptable).
// 사유를 골라 보내면 대원 앱에 경보가 가고, 대원은 직전 환자 정보로 다른 병원에 다시 요청한다
export function UnacceptableButton({ requestId, version }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // 빠르게 두 번 눌러도 한 번만 보낸다
  const sending = useRef(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hw', 'incoming'] });
    void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
  };

  const send = useMutation({
    mutationFn: (body: Omit<RejectBody, 'version'>) =>
      apiFetch(`/hw/requests/${requestId}/unacceptable`, {
        method: 'POST',
        body: JSON.stringify({ ...body, version }),
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
        <p role="alert" className="text-lg font-bold text-destructive">
          {unacceptableErrorText(send.error)}
        </p>
      )}
      <Button
        size="lg"
        variant="destructive"
        className="h-12 text-lg"
        disabled={send.isPending}
        onClick={() => {
          send.reset();
          setOpen(true);
        }}
      >
        수용 불가
      </Button>
      <RejectReasonDialog
        key={open ? 'open' : 'closed'}
        kind="unacceptable"
        open={open}
        pending={send.isPending}
        error={send.isError ? unacceptableErrorText(send.error) : null}
        onSubmit={(body) => {
          if (sending.current) return;
          sending.current = true;
          send.mutate(body);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
