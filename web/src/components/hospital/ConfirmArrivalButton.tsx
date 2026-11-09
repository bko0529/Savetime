'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';

type Result =
  ApiPaths['/hw/requests/{requestId}/confirm-arrival']['post']['responses'][200]['content']['application/json'];

function confirmErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return errorText(error);
  switch (error.code) {
    // 병원 웹에는 구급차 위치·거리를 보여 주지 않는다. 가깝지 않다는 것만 알린다
    case 'AMBULANCE_NOT_NEAR':
      return '구급차가 아직 응급실 입구 가까이 오지 않았어요';
    case 'VERSION_CONFLICT':
    case 'INVALID_TRANSITION':
      return '그사이 상태가 바뀌었어요. 최신 상태로 다시 보여 드릴게요';
    default:
      return errorText(error);
  }
}

type Props = {
  requestId: number;
  // 화면에 보여 준 요청의 version. 그사이 바뀌었으면 서버가 막는다 (SFR-160)
  version: number;
  // 서버가 알려 준 '지금 누를 수 있나' (위치 있는 건은 입구 200m 안일 때만, 위치 없는 건은 항상)
  enabled: boolean;
};

// 도착 예정 목록의 '도착 확인' (SFR-144, H-03).
// 위치 있는 건은 바로 '도착'으로 끝나고, 위치 없는 건은 대원 앱에 도착 처리를 요청한다
export function ConfirmArrivalButton({ requestId, version, enabled }: Props) {
  const queryClient = useQueryClient();
  // 빠르게 두 번 눌러도 한 번만 보낸다
  const sending = useRef(false);

  const confirm = useMutation({
    mutationFn: () =>
      apiFetch<Result>(`/hw/requests/${requestId}/confirm-arrival`, {
        method: 'POST',
        body: JSON.stringify({ version }),
      }),
    onSettled: () => {
      sending.current = false;
      // 도착이면 상태가 '도착'으로, 막혔으면 최신 상태(버튼 비활성 등)로 다시 그린다
      void queryClient.invalidateQueries({ queryKey: ['hw', 'incoming'] });
      void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="lg"
        className="h-12 text-lg"
        disabled={!enabled || confirm.isPending}
        title={enabled ? undefined : '구급차가 응급실 입구 가까이 오면 누를 수 있어요'}
        onClick={() => {
          if (sending.current) return;
          sending.current = true;
          confirm.mutate();
        }}
      >
        {confirm.isPending ? '확인 중…' : '도착 확인'}
      </Button>
      {confirm.data?.result === 'asked_paramedic' && (
        <p role="status" className="text-lg font-bold">
          대원 앱에 도착 처리를 요청했어요
        </p>
      )}
      {confirm.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {confirmErrorText(confirm.error)}
        </p>
      )}
    </div>
  );
}
