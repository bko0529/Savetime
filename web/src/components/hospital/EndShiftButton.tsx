'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, apiFetch } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { dialog } from './dialogStyles';

// 근무 종료 (SFR-117). 이 PC 만 요청 대상에서 빠진다. 같은 PC 의 다른 탭은 서버가 보내는
// hospital.alarm_off{shift_ended} 를 받아 같이 근무 시작 화면으로 돌아간다 (useHospitalAlarm)
export function EndShiftButton({ waitingCount }: { waitingCount: number }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const end = useMutation({
    mutationFn: async () => {
      try {
        await apiFetch('/hw/shifts/current/end', { method: 'POST' });
      } catch (error) {
        // 다른 탭에서 이미 끝냈으면(404) 이미 원하는 상태라 오류로 보지 않는다
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    },
    onSuccess: () => {
      setConfirming(false);
      // 근무 정보가 없어졌으니 다시 받으면 근무 시작 화면이 나온다
      void queryClient.invalidateQueries({ queryKey: ['hw', 'session'] });
    },
  });

  return (
    <>
      <Button
        variant="outline"
        className="h-[44px] rounded-[10px] border-2 bg-card px-4 text-[17px]"
        onClick={() => {
          end.reset();
          setConfirming(true);
        }}
      >
        근무 종료
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next) setConfirming(false);
        }}
      >
        <DialogContent
          showCloseButton={false}
          overlayClassName={dialog.overlay}
          className={dialog.content}
        >
          <DialogTitle className={dialog.title}>근무를 끝낼까요?</DialogTitle>
          <DialogDescription className={dialog.description}>
            이 PC는 새 이송 요청 알림을 받지 않아요. 다른 PC는 그대로 받아요.
          </DialogDescription>
          {waitingCount > 0 && (
            <p className="text-xl font-bold text-destructive">
              아직 응답하지 않은 요청 {waitingCount}건이 있어요.
            </p>
          )}
          {end.isError && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {errorText(end.error)}
            </p>
          )}
          <DialogFooter className={dialog.footer}>
            <Button
              variant="outline"
              size="lg"
              className={dialog.button}
              onClick={() => setConfirming(false)}
            >
              취소
            </Button>
            <Button
              variant="destructive"
              size="lg"
              className={dialog.button}
              disabled={end.isPending}
              onClick={() => end.mutate()}
            >
              {end.isPending ? '끝내는 중…' : '근무 종료'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
