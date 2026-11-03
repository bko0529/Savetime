'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { showRequestNotification, startAlarmLoop, stopAlarmLoop } from '@/lib/alarm/browserAlarm';
import { apiFetch, type ApiPaths } from '@/lib/api/client';
import type { components } from '@/lib/api/schema';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';
import { useTabTitleAlert } from '@/hooks/useTabTitleAlert';
import type { OverlayRequest } from '@/components/hospital/NewRequestOverlay';

type RequestList = ApiPaths['/hw/requests']['get']['responses'][200]['content']['application/json'];
export type HwRequestItem = components['schemas']['HwRequestItem'];

export const REQUESTS_KEY = ['hw', 'requests', 'open'] as const;

function toOverlay(item: HwRequestItem): OverlayRequest | null {
  if (item.id === undefined || !item.respondUntil) return null;
  return {
    id: item.id,
    label: item.label ?? `R-${item.id}`,
    chiefComplaint: item.chiefComplaint ?? null,
    etaMin: item.etaMin ?? null,
    respondUntil: item.respondUntil,
  };
}

// 새 이송 요청 받기 (SFR-117·135·161, 실시간 설계 표 108줄)
// 이벤트는 '새 요청 왔어요' 벨일 뿐이고 환자 정보는 없다. 내용은 GET /hw/requests 로 받는다 (SER-014)
export function useNewRequests(socket: HospitalSocket | null) {
  const queryClient = useQueryClient();

  const requests = useQuery({
    queryKey: REQUESTS_KEY,
    queryFn: async () => {
      const list = await apiFetch<RequestList>('/hw/requests?status=open');
      // 남은 시간은 서버 시각 기준 (SFR-110). PC 시계가 틀려도 2분 마감이 맞게 보이도록 차이를 기억한다
      const offsetMs = list.serverNow ? Date.parse(list.serverNow) - Date.now() : 0;
      return { items: list.items, offsetMs };
    },
    enabled: socket !== null,
  });

  useEffect(() => {
    if (!socket) return;
    const refetch = () => void queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
    const onNew: Parameters<typeof socket.on<'request.new'>>[1] = (_e, ack) => {
      // 무엇보다 먼저 '받았어요'. 5초 안에 안 보내면 서버가 이 PC 알림을 끄고 전달 실패로 센다 (SFR-161)
      ack({ received: true });
      refetch();
    };
    socket.on('request.new', onNew);
    // 다른 PC 응답·만료·닫힘으로 요청이 끝나면 창과 소리를 멈추기 위해 다시 받는다
    socket.on('request.changed', refetch);
    // 재연결 때는 놓친 게 있을 수 있어 항상 전체를 다시 받는다 (실시간 설계 B)
    socket.on('connect', refetch);
    return () => {
      socket.off('request.new', onNew);
      socket.off('request.changed', refetch);
      socket.off('connect', refetch);
    };
  }, [socket, queryClient]);

  // '확인'을 누른 요청. 덮개 창만 닫고, 응답 대기는 그대로라 소리·탭 제목은 계속된다
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(new Set());

  const waiting = useMemo(
    () =>
      (requests.data?.items ?? [])
        .filter((r) => r.status === 'waiting')
        .map(toOverlay)
        .filter((r): r is OverlayRequest => r !== null)
        .sort((a, b) => Date.parse(a.respondUntil) - Date.parse(b.respondUntil)),
    [requests.data],
  );
  const overlay = waiting.find((r) => !confirmed.has(r.id)) ?? null;

  useTabTitleAlert(waiting.length);

  // 대기 요청이 하나라도 있으면 소리 1개 반복, 0건이 되면 멈춤
  const hasWaiting = waiting.length > 0;
  useEffect(() => {
    if (hasWaiting) startAlarmLoop();
    else stopAlarmLoop();
  }, [hasWaiting]);
  useEffect(() => () => stopAlarmLoop(), []);

  // 브라우저 알림은 요청마다 1번만
  const notified = useRef(new Set<number>());
  useEffect(() => {
    for (const r of waiting) {
      if (notified.current.has(r.id)) continue;
      notified.current.add(r.id);
      showRequestNotification(r.id, r.label);
    }
  }, [waiting]);

  // 덮개 창이 떠 있는 동안만 1초마다 서버 기준 시각을 다시 계산한다
  const offsetMs = requests.data?.offsetMs ?? 0;
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (!overlay) return;
    const tick = () => setNowMs(Date.now() + offsetMs);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [overlay, offsetMs]);

  function confirm(id: number) {
    setConfirmed((prev) => new Set(prev).add(id));
  }

  return { waiting, overlay, nowMs, confirm };
}
