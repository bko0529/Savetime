'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiFetch, type ApiPaths } from '@/savetime-web/lib/api/client';
import type { components } from '@/savetime-web/lib/api/schema';
import type { HospitalSocket } from '@/savetime-web/lib/realtime/hospitalSocket';

type IncomingList =
  ApiPaths['/hw/incoming']['get']['responses'][200]['content']['application/json'];
export type HwIncoming = components['schemas']['HwIncoming'];
export type RemovedReason = 'cancelled' | 'dest_changed' | 'approval_cancelled';
export type RemovedNotice = { requestId: number; reason: RemovedReason };

export const INCOMING_KEY = ['hw', 'incoming'] as const;
// 요청 상세(RequestDetail 의 detailKey)와 같은 키. 상세를 여기서 직접 가져오면 서로 불러오는 고리가 생겨 글자로 둔다
const detailOf = (requestId: number) => ['hw', 'requests', 'detail', requestId] as const;

// 도착 예정 환자 (SFR-121, H-03). 이벤트에는 ID·시각만 오고, 내용은 GET /hw/incoming 으로 받는다 (규칙 5)
export function useIncoming(socket: HospitalSocket | null) {
  const queryClient = useQueryClient();
  // 목록에서 빠진 이유(이송 취소·목적지 변경·승인 취소). 놓치면 안 되는 일이라 사람이 '확인'을 누를 때까지 남긴다
  const [notices, setNotices] = useState<RemovedNotice[]>([]);

  const incoming = useQuery({
    queryKey: INCOMING_KEY,
    queryFn: () => apiFetch<IncomingList>('/hw/incoming'),
    enabled: socket !== null,
  });

  useEffect(() => {
    if (!socket) return;
    const refetch = () => void queryClient.invalidateQueries({ queryKey: INCOMING_KEY });
    // 남은 시간이 바뀌었거나(etaMin) 대원이 환자 정보를 고쳐 보냈다(changedFields, SFR-105).
    // 환자 정보가 바뀐 때만 열린 상세도 다시 받는다. 다시 받을 때마다 열람 기록이 남아서(SFR-137) 1분마다 받지는 않는다
    const onUpdated: Parameters<typeof socket.on<'incoming.updated'>>[1] = (e) => {
      refetch();
      if (e.data.changedFields?.length) {
        void queryClient.invalidateQueries({ queryKey: detailOf(e.data.requestId) });
      }
    };
    const onRemoved: Parameters<typeof socket.on<'incoming.removed'>>[1] = (e) => {
      const { requestId, reason } = e.data;
      setNotices((prev) => [
        ...prev.filter((n) => n.requestId !== requestId),
        { requestId, reason },
      ]);
      refetch();
    };
    // 새로 확정·도착 예상 갱신·도착: 목록을 다시 받는다. 재연결 때는 놓친 게 있을 수 있어 전체를 다시 받는다
    socket.on('incoming.added', refetch);
    socket.on('incoming.updated', onUpdated);
    // 구급차가 입구 200m 안에 들어옴 → 목록을 다시 받아야 '도착 확인' 버튼이 켜진다 (SFR-144)
    socket.on('incoming.near', refetch);
    socket.on('incoming.arrived', refetch);
    socket.on('incoming.removed', onRemoved);
    socket.on('connect', refetch);
    return () => {
      socket.off('incoming.added', refetch);
      socket.off('incoming.updated', onUpdated);
      socket.off('incoming.near', refetch);
      socket.off('incoming.arrived', refetch);
      socket.off('incoming.removed', onRemoved);
      socket.off('connect', refetch);
    };
  }, [socket, queryClient]);

  function dismiss(requestId: number) {
    setNotices((prev) => prev.filter((n) => n.requestId !== requestId));
  }

  return {
    items: incoming.data?.items ?? [],
    isError: incoming.isError,
    error: incoming.error,
    notices,
    dismiss,
  };
}
