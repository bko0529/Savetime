'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

export const MEMO_MAX = 50;

type Props = {
  open: boolean;
  pending: boolean;
  // 보냈는데 서버가 거절한 이유 (창이 열린 채라 창 안에 보여 준다)
  error: string | null;
  onSubmit: (memo: string) => void;
  onCancel: () => void;
};

// 추가 메모 쓰기 창 (SFR-140). 확정된 요청에 한 번만 보낼 수 있어서 보내기 전에 한 번 더 알려 준다
export function ExtraMemoDialog({ open, pending, error, onSubmit, onCancel }: Props) {
  const [memo, setMemo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (memo.trim() === '') return setProblem('메모를 적어 주세요');
    onSubmit(memo.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} className="gap-6 p-6 sm:max-w-lg">
        <DialogTitle className="text-2xl font-bold">추가 메모</DialogTitle>
        <DialogDescription className="text-lg">
          대원 앱에 경보와 함께 보여요. 한 번만 보낼 수 있어요.
        </DialogDescription>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-1 text-lg">
            메모 ({MEMO_MAX}자까지)
            <input
              value={memo}
              onChange={(e) => {
                setMemo(e.target.value.slice(0, MEMO_MAX));
                setProblem(null);
              }}
              maxLength={MEMO_MAX}
              // 메모는 대원에게 그대로 보인다. 환자를 알아볼 수 있는 내용은 쓰지 않게 안내한다
              placeholder="예: CT 고장, 2번 입구로 오세요"
              className="h-12 rounded-lg border-2 border-input px-3 text-xl"
              autoFocus
            />
          </label>
          {(problem ?? error) && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {problem ?? error}
            </p>
          )}
          <DialogFooter className="-mx-6 -mb-6 p-6">
            <Button type="button" variant="outline" size="lg" onClick={onCancel}>
              취소
            </Button>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? '보내는 중…' : '추가 메모 보내기'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
