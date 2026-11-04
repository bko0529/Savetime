'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { RejectReasonDialog, type RejectBody } from './RejectReasonDialog';

type Answer =
  | { kind: 'approve'; overApprovalConfirmed?: boolean }
  | ({ kind: 'reject' } & Omit<RejectBody, 'version'>);

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
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
]);

type Props = {
  requestId: number;
  // 상세를 열 때 받은 version. 그사이 다른 PC 가 응답했으면 서버가 막는다 (SFR-160)
  version: number;
  // 대기 중이고 남은 시간이 있을 때만 버튼을 보여 준다
  canAnswer: boolean;
};

// 승인·거절 (SFR-119). 응답자 이름은 서버가 근무 시작 때 입력한 담당자 이름으로 남긴다
export function RequestActions({ requestId, version, canAnswer }: Props) {
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
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
      setRejecting(false);
      // 목록(대기 건수·알림음)과 상세를 새 상태로
      void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && STALE_CODES.has(error.code)) {
        setRejecting(false);
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
          onClick={() => send({ kind: 'approve', overApprovalConfirmed: true })}
        >
          그래도 승인
        </Button>
      )}
      {canAnswer && (
        <div className="flex gap-4">
          <Button
            size="lg"
            className="h-16 min-w-40 text-2xl"
            disabled={answer.isPending}
            onClick={() => send({ kind: 'approve' })}
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
              setRejecting(true);
            }}
          >
            거절
          </Button>
        </div>
      )}
      <RejectReasonDialog
        key={String(rejecting)}
        open={rejecting}
        pending={answer.isPending}
        error={answer.isError ? answerErrorText(answer.error) : null}
        onSubmit={(body) => send({ kind: 'reject', ...body })}
        onCancel={() => setRejecting(false)}
      />
    </div>
  );
}
