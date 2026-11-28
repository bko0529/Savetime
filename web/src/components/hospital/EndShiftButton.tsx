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

// 위쪽 막대의 '근무 종료' (SFR-117, H-02). 근무가 끝나면 이 PC 는 새 요청을 받지 않으므로
// 잘못 누르지 않게 한 번 더 묻는다. 끝나면 근무 시작 화면으로 돌아간다(세션을 다시 받음).
// 같은 PC 의 다른 탭은 서버가 보내는 hospital.alarm_off{shift_ended} 를 받아 같이 돌아간다
export function EndShiftButton({
  staffName,
  waitingCount = 0,
}: {
  staffName?: string;
  // 아직 응답하지 않은(2분이 안 지난) 요청 수. 있으면 확인창에서 한 번 더 알려 준다
  waitingCount?: number;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const end = useMutation({
    mutationFn: async () => {
      try {
        await apiFetch('/hw/shifts/current/end', { method: 'POST' });
      } catch (error) {
        // 다른 탭에서 이미 끝냈으면(404) 원하던 상태라 오류로 보지 않고 근무 시작 화면으로 간다
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    },
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['hw', 'session'] });
    },
  });

  return (
    <>
      <Button
        variant="outline"
        className="h-[44px] rounded-[10px] border-line bg-card px-4 text-[17px] font-bold"
        onClick={() => {
          end.reset();
          setOpen(true);
        }}
      >
        근무 종료
      </Button>
      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <DialogContent
          showCloseButton={false}
          overlayClassName={dialog.overlay}
          className={dialog.content}
        >
          <DialogTitle className={dialog.title}>근무를 끝낼까요?</DialogTitle>
          <DialogDescription className={dialog.description}>
            {staffName ? `${staffName} 님의 근무를 끝내요. ` : ''}이 PC는 새 이송 요청을 받지
            않아요. 근무 중인 다른 PC가 없으면 우리 병원으로 요청이 오지 않아요.
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
              onClick={() => setOpen(false)}
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
