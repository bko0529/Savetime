'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { MEMO_MAX } from './ExtraMemoDialog';
import { RejectReasonDialog, type RejectBody } from './RejectReasonDialog';

type Answer =
  | { kind: 'approve'; memo?: string; overApprovalConfirmed?: boolean }
  | ({ kind: 'reject' | 'cancel-approval' } & Omit<RejectBody, 'version'>);

const RESPONDED_TEXT: Record<string, string> = { approved: '승인', rejected: '거절' };

// 응답이 거절됐을 때 병원 직원에게 보여 줄 말 (SFR-153·160, 오류 코드표)
function answerErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return errorText(error);
  const d = (error.details ?? {}) as {
    respondedBy?: string;
    pcName?: string;
    status?: string;
    validApprovals?: number;
    erAvail?: number;
  };
  switch (error.code) {
    case 'ALREADY_RESPONDED': {
      const what = RESPONDED_TEXT[d.status ?? ''] ?? '응답';
      const who = [d.respondedBy, d.pcName].filter(Boolean).join(' · ');
      return `다른 PC에서 이미 ${what}했어요${who ? ` (${who})` : ''}`;
    }
    case 'REQUEST_EXPIRED':
      return '응답 시간(2분)이 지났어요';
    case 'OVER_APPROVAL_CONFIRM_REQUIRED':
      return `지금 유효한 승인 ${d.validApprovals ?? '?'}건 · 응급실 가용 병상 ${d.erAvail ?? '?'}개예요. 병상보다 많이 승인해요`;
    case 'REQUEST_CLOSED':
      return '이미 끝난 요청이에요';
    case 'REQUEST_NOT_APPROVED':
      return '승인한 요청이 아니라서 승인 취소할 수 없어요';
    case 'VERSION_CONFLICT':
    case 'INVALID_TRANSITION':
      return '그사이 요청 상태가 바뀌었어요. 최신 상태로 다시 보여 드릴게요';
    default:
      return errorText(error);
  }
}

// 상태가 바뀌어 거절된 응답이면 목록·상세를 다시 받아 지금 상태를 보여 준다
const STALE_CODES = new Set([
  'ALREADY_RESPONDED',
  'REQUEST_EXPIRED',
  'REQUEST_CLOSED',
  'REQUEST_NOT_APPROVED',
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
]);

type Props = {
  requestId: number;
  // 상세를 열 때 받은 version. 그사이 다른 PC 가 응답했으면 서버가 막는다 (SFR-160)
  version: number;
  // 대기 중이고 남은 시간이 있을 때만 버튼을 보여 준다
  canAnswer: boolean;
  // 승인했거나 우리 병원으로 확정된 요청이면 '승인 취소'를 보여 준다 (SFR-128)
  canCancelApproval?: boolean;
};

// 승인·거절 (SFR-119), 승인 취소 (SFR-128). 응답자 이름은 서버가 근무 시작 때 입력한 담당자 이름으로 남긴다
export function RequestActions({ requestId, version, canAnswer, canCancelApproval }: Props) {
  const queryClient = useQueryClient();
  // 열려 있는 사유 창: 거절 / 승인 취소
  const [reasonFor, setReasonFor] = useState<'reject' | 'cancelApproval' | null>(null);
  // 승인 메모 (SFR-140). 승인할 때 같이 보내면 대원 앱 승인 카드에 보인다
  const [approveMemo, setApproveMemo] = useState('');
  // 비어 있으면 아예 보내지 않는다
  const approve = (extra: { overApprovalConfirmed?: boolean } = {}): Answer => ({
    kind: 'approve',
    ...(approveMemo.trim() ? { memo: approveMemo.trim() } : {}),
    ...extra,
  });
  // 빠르게 두 번 누르면 화면이 '보내는 중'으로 바뀌기 전에 두 번째 클릭이 들어온다. 그래서 바로 막는 표시를 따로 둔다
  const sending = useRef(false);

  const answer = useMutation({
    mutationFn: (a: Answer) => {
      const { kind, ...rest } = a;
      return apiFetch(`/hw/requests/${requestId}/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ ...rest, version }),
      });
    },
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: () => {
      setReasonFor(null);
      // 목록(대기 건수·알림음)과 상세를 새 상태로
      void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && STALE_CODES.has(error.code)) {
        setReasonFor(null);
        void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
      }
    },
  });

  function send(a: Answer) {
    if (sending.current) return;
    sending.current = true;
    answer.mutate(a);
  }

  // 과승인 경고를 받았으면 한 번 더 눌러야 승인된다 (SFR-154)
  const overApproval =
    answer.error instanceof ApiError && answer.error.code === 'OVER_APPROVAL_CONFIRM_REQUIRED';

  return (
    <div className="flex flex-col gap-3">
      {answer.isError && (
        <p role="alert" className="text-xl font-bold text-destructive">
          {answerErrorText(answer.error)}
        </p>
      )}
      {canAnswer && overApproval && (
        <Button
          size="lg"
          className="h-14 w-fit text-xl"
          disabled={answer.isPending}
          onClick={() => send(approve({ overApprovalConfirmed: true }))}
        >
          그래도 승인
        </Button>
      )}
      {canAnswer && (
        <label className="flex max-w-xl flex-col gap-1 text-lg">
          승인 메모 (선택, {MEMO_MAX}자까지)
          <input
            value={approveMemo}
            onChange={(e) => setApproveMemo(e.target.value.slice(0, MEMO_MAX))}
            maxLength={MEMO_MAX}
            placeholder="예: 3번 출입구로 오세요"
            className="h-12 rounded-lg border-2 border-input px-3 text-xl"
          />
        </label>
      )}
      {canAnswer && (
        <div className="flex gap-4">
          <Button
            size="lg"
            className="h-16 min-w-40 text-2xl"
            disabled={answer.isPending}
            onClick={() => send(approve())}
          >
            {answer.isPending && answer.variables?.kind === 'approve' ? '승인 중…' : '승인'}
          </Button>
          <Button
            size="lg"
            variant="destructive"
            className="h-16 min-w-40 text-2xl"
            disabled={answer.isPending}
            onClick={() => {
              answer.reset();
              setReasonFor('reject');
            }}
          >
            거절
          </Button>
        </div>
      )}
      {canCancelApproval && (
        <Button
          size="lg"
          variant="outline"
          className="h-14 w-fit border-2 border-destructive text-xl text-destructive"
          disabled={answer.isPending}
          onClick={() => {
            answer.reset();
            setReasonFor('cancelApproval');
          }}
        >
          승인 취소
        </Button>
      )}
      <RejectReasonDialog
        key={reasonFor ?? 'closed'}
        kind={reasonFor ?? 'reject'}
        open={reasonFor !== null}
        pending={answer.isPending}
        error={reasonFor && answer.isError ? answerErrorText(answer.error) : null}
        onSubmit={(body) =>
          send({ kind: reasonFor === 'cancelApproval' ? 'cancel-approval' : 'reject', ...body })
        }
        onCancel={() => setReasonFor(null)}
      />
    </div>
  );
}
