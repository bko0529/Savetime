'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';

// 'HH:MM' (PC 시각대로 보여 준다. 판정이 아니라 표시만)
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

type Props = {
  paused: boolean;
  pausedAt: string | null;
  // 지금 응답 대기 중인 요청 수. 중지하면 이만큼 거절(요청 중지)로 처리된다
  waitingCount: number;
  socket: HospitalSocket | null;
};

// 잠시 요청 중지 / 요청 다시 받기 (SFR-139). 병원 전체에 적용돼서 한 PC 에서 누르면 모든 PC 가 같이 바뀐다
export function PauseControl({ paused, pausedAt, waitingCount, socket }: Props) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  // 중지 2시간째 서버가 보내는 '아직 멈춘 상태' 알림. 다시 받으면 사라진다
  const [reminded, setReminded] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hw', 'session'] });
    // 대기 요청이 거절로 바뀌었으니 목록·열린 상세도 다시 받는다
    void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
  };

  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      apiFetch('/hw/pause', { method: 'PUT', body: JSON.stringify({ paused: next }) }),
    onSuccess: () => {
      setConfirming(false);
      setReminded(false);
      refresh();
    },
  });

  // 다른 PC 가 중지·해제했을 때와 2시간 알림 (이벤트에는 PC 이름·시각만, 내용은 GET 으로)
  useEffect(() => {
    if (!socket) return;
    const onChanged = () => {
      setReminded(false);
      void queryClient.invalidateQueries({ queryKey: ['hw', 'session'] });
      void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
    };
    const onReminder = () => setReminded(true);
    socket.on('hospital.pause_changed', onChanged);
    socket.on('hospital.pause_reminder', onReminder);
    return () => {
      socket.off('hospital.pause_changed', onChanged);
      socket.off('hospital.pause_reminder', onReminder);
    };
  }, [socket, queryClient]);

  if (paused) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-4 rounded-lg border-2 border-destructive bg-destructive/10 px-4 py-3"
      >
        <div className="flex flex-col gap-1">
          <p className="text-2xl font-extrabold text-destructive">
            ⏸ 요청 중지 중{pausedAt ? ` (${clock(pausedAt)}부터)` : ''}
          </p>
          <p className="text-lg">새 이송 요청을 받지 않아요.</p>
          {reminded && (
            <p role="alert" className="text-xl font-bold text-destructive">
              아직 요청을 멈춘 상태예요. 받을 수 있으면 다시 받아 주세요.
            </p>
          )}
          {toggle.isError && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {errorText(toggle.error)}
            </p>
          )}
        </div>
        <Button
          size="lg"
          className="h-14 text-xl"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(false)}
        >
          {toggle.isPending ? '바꾸는 중…' : '요청 다시 받기'}
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button
        size="lg"
        variant="outline"
        className="h-12 w-fit border-2 text-lg"
        onClick={() => {
          toggle.reset();
          setConfirming(true);
        }}
      >
        잠시 요청 중지
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next) setConfirming(false);
        }}
      >
        <DialogContent showCloseButton={false} className="gap-6 p-6 sm:max-w-lg">
          <DialogTitle className="text-2xl font-bold">잠시 요청을 멈출까요?</DialogTitle>
          <DialogDescription className="text-lg">
            우리 병원 모든 PC에 적용돼요. &apos;요청 다시 받기&apos;를 누를 때까지 새 이송 요청을
            받지 않아요.
          </DialogDescription>
          {waitingCount > 0 ? (
            <p className="text-xl font-bold text-destructive">
              응답 대기 {waitingCount}건이 거절(요청 중지)로 처리돼요. 이미 승인한 요청은
              그대로예요.
            </p>
          ) : (
            <p className="text-lg">응답 대기 중인 요청은 없어요.</p>
          )}
          {toggle.isError && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {errorText(toggle.error)}
            </p>
          )}
          <DialogFooter className="-mx-6 -mb-6 p-6">
            <Button variant="outline" size="lg" onClick={() => setConfirming(false)}>
              취소
            </Button>
            <Button
              variant="destructive"
              size="lg"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(true)}
            >
              {toggle.isPending ? '멈추는 중…' : '요청 중지'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
