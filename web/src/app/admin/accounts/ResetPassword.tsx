'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { useAdminApi } from '../useAdminApi';

type Reset =
  ApiPaths['/admin/paramedics/{id}/reset-password']['post']['responses'][200]['content']['application/json'];

// 비밀번호 초기화 (SFR-021, A-01). 확인 → 임시 비밀번호를 이 창에서 한 번만 보여 준다.
// 관리자는 소속 기관 전화로 본인을 확인한 뒤 불러 준다. 창을 닫으면 화면 메모리에서도 지워 다시 볼 수 없다
export function ResetPasswordButton({ paramedic }: { paramedic: { id?: number; name?: string } }) {
  const api = useAdminApi();
  const [confirming, setConfirming] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = useMutation({
    mutationFn: () =>
      api<Reset>(`/admin/paramedics/${paramedic.id}/reset-password`, { method: 'POST' }),
    onSuccess: (result) => {
      setConfirming(false);
      setTemp(result.tempPassword ?? null);
    },
  });

  function closeTemp() {
    setTemp(null);
    setCopied(false);
  }

  return (
    <>
      <Button
        variant="outline"
        aria-label={`${paramedic.name} 비밀번호 초기화`}
        onClick={() => {
          reset.reset();
          setConfirming(true);
        }}
      >
        비밀번호 초기화
      </Button>

      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-lg">
          <DialogTitle className="text-2xl font-bold">{paramedic.name} 비밀번호 초기화</DialogTitle>
          <DialogDescription className="text-lg">
            소속 기관 전화로 본인인지 먼저 확인하세요. 초기화하면 임시 비밀번호를 한 번만 보여 주고,
            지금 로그인된 기기는 모두 로그아웃돼요.
          </DialogDescription>
          {reset.isError && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {errorText(reset.error)}
            </p>
          )}
          <DialogFooter className="-mx-6 -mb-6 p-6">
            <Button variant="outline" size="lg" onClick={() => setConfirming(false)}>
              취소
            </Button>
            <Button
              variant="destructive"
              size="lg"
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
            >
              {reset.isPending ? '처리 중…' : '초기화'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={temp !== null}
        disablePointerDismissal
        onOpenChange={(open) => !open && closeTemp()}
      >
        <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-lg">
          <DialogTitle className="text-2xl font-bold">{paramedic.name} 임시 비밀번호</DialogTitle>
          <DialogDescription className="text-lg font-bold text-destructive">
            이 창을 닫으면 다시 볼 수 없어요. 대원은 이 비밀번호로 로그인한 뒤 새 비밀번호로 바꿔야
            해요.
          </DialogDescription>
          <p
            aria-label="임시 비밀번호"
            className="rounded-lg border-2 border-foreground bg-muted p-4 text-center font-mono text-2xl font-bold tracking-wider break-all"
          >
            {temp}
          </p>
          <DialogFooter className="-mx-6 -mb-6 p-6">
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                if (!temp) return;
                void navigator.clipboard?.writeText(temp).then(() => setCopied(true));
              }}
            >
              {copied ? '복사됨' : '복사'}
            </Button>
            <Button size="lg" onClick={closeTemp}>
              확인했어요
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
