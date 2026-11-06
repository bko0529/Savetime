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
import type { ApiPaths } from '@/lib/api/client';

export type RejectBody =
  ApiPaths['/hw/requests/{requestId}/reject']['post']['requestBody']['content']['application/json'];
export type RejectReason = RejectBody['reason'];

// 거절 사유 (SFR-119, 구급활동일지 재이송 사유와 대응: 부록 G, D-115).
// '요청 중지'는 시스템이 자동으로 붙이는 사유라 여기에는 없다 (SFR-139)
export const REJECT_REASONS: { value: RejectReason; label: string }[] = [
  { value: 'er_bed', label: '응급실 병상 부족' },
  { value: 'or_room', label: '수술실 부족' },
  { value: 'ward', label: '입원실 부족' },
  { value: 'icu', label: '중환자실 부족' },
  { value: 'no_specialist', label: '해당 전문의 부재' },
  { value: 'equipment', label: '의료장비 고장(CT 등)' },
  { value: 'etc', label: '기타' },
];
export const ETC_TEXT_MAX = 20;

// 거절(SFR-119)과 승인 취소(SFR-128)는 같은 사유 7가지를 쓴다. 창 글자만 다르다
const TEXT = {
  reject: {
    title: '거절 사유',
    description: '대원 앱에 병원 이름과 함께 이 사유가 보여요.',
    missing: '거절 사유를 골라 주세요',
    submit: '거절 보내기',
  },
  cancelApproval: {
    title: '승인 취소 사유',
    description:
      '대원 앱에 경보와 함께 이 사유가 보여요. 이 병원은 이번 이송에서 다시 요청받지 않아요.',
    missing: '사유를 골라 주세요',
    submit: '승인 취소 보내기',
  },
};

type Props = {
  kind?: keyof typeof TEXT;
  open: boolean;
  pending: boolean;
  // 보냈는데 서버가 거절한 이유 (창이 열린 채라 창 안에 보여 준다)
  error: string | null;
  onSubmit: (body: Omit<RejectBody, 'version'>) => void;
  onCancel: () => void;
};

// 거절·승인 취소 사유 고르기 창. 사유를 고르지 않으면 보내지 않는다
export function RejectReasonDialog({
  kind = 'reject',
  open,
  pending,
  error,
  onSubmit,
  onCancel,
}: Props) {
  const text = TEXT[kind];
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [etcText, setEtcText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!reason) return setProblem(text.missing);
    if (reason === 'etc' && etcText.trim() === '') return setProblem('기타 사유를 적어 주세요');
    onSubmit({ reason, etcText: reason === 'etc' ? etcText.trim() : null });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} className="gap-6 p-6 sm:max-w-lg">
        <DialogTitle className="text-2xl font-bold">{text.title}</DialogTitle>
        <DialogDescription className="text-lg">{text.description}</DialogDescription>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{text.title}</legend>
            {REJECT_REASONS.map((r) => (
              <label key={r.value} className="flex min-h-11 items-center gap-3 text-xl">
                <input
                  type="radio"
                  name="reject-reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => {
                    setReason(r.value);
                    setProblem(null);
                  }}
                  className="size-5"
                />
                {r.label}
              </label>
            ))}
          </fieldset>
          {reason === 'etc' && (
            <label className="flex flex-col gap-1 text-lg">
              기타 사유 ({ETC_TEXT_MAX}자까지)
              {/* 환자를 알아볼 수 있는 내용은 쓰지 않게 안내한다 */}
              <input
                value={etcText}
                onChange={(e) => {
                  setEtcText(e.target.value.slice(0, ETC_TEXT_MAX));
                  setProblem(null);
                }}
                maxLength={ETC_TEXT_MAX}
                placeholder="환자 이름·연락처는 쓰지 마세요"
                className="h-12 rounded-lg border-2 border-input px-3 text-xl"
                autoFocus
              />
            </label>
          )}
          {(problem ?? error) && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {problem ?? error}
            </p>
          )}
          <DialogFooter className="-mx-6 -mb-6 p-6">
            <Button type="button" variant="outline" size="lg" onClick={onCancel}>
              취소
            </Button>
            <Button type="submit" variant="destructive" size="lg" disabled={pending}>
              {pending ? '보내는 중…' : text.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
