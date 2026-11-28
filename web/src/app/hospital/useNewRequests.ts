'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, type ApiPaths } from '@/lib/api/client';
import type { components } from '@/lib/api/schema';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';
import { useTabTitleAlert } from '@/hooks/useTabTitleAlert';
import type { OverlayRequest } from '@/components/hospital/NewRequestOverlay';

type RequestList = ApiPaths['/hw/requests']['get']['responses'][200]['content']['application/json'];
export type HwRequestItem = components['schemas']['HwRequestItem'];

export const REQUESTS_KEY = ['hw', 'requests', 'open'] as const;
// 한꺼번에 쌓아 보여줄 작은 알림 수
const TOAST_LIMIT = 3;

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
  // request.new 로 받은 요청 번호 (작은 알림용, 이 탭 화면 표시에만 쓴다)
  const arrived = useRef(new Set<number>());

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
    const refetchList = () => void queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
    // 목록과 열려 있는 상세를 같이 다시 받는다 (['hw','requests'] 로 시작하는 것 전부)
    const refetchAll = () => void queryClient.invalidateQueries({ queryKey: ['hw', 'requests'] });
    const onNew: Parameters<typeof socket.on<'request.new'>>[1] = (e, ack) => {
      // 무엇보다 먼저 '받았어요'. 5초 안에 안 보내면 서버가 전달 실패로 세고 이 탭 등록을 푼다 (SFR-161)
      ack({ received: true });
      // 방금 도착한 요청 번호를 기억해 두었다가, 목록을 받으면 작은 알림으로 띄운다
      arrived.current.add(e.data.requestId);
      refetchList();
    };
    socket.on('request.new', onNew);
    // 대기·승인 중에 대원이 환자 정보를 고쳐 보냄 (SFR-105): 목록 이상 수치와 열린 상세를 새로 받는다
    const onUpdated: Parameters<typeof socket.on<'request.updated'>>[1] = (e) => {
      refetchList();
      void queryClient.invalidateQueries({
        queryKey: ['hw', 'requests', 'detail', e.data.requestId],
      });
    };
    socket.on('request.updated', onUpdated);
    // 길찾기로 도착 예상이 바뀜 (SFR-129). 목록·작은 알림의 도착 예상만 바뀌므로 목록만 다시 받는다
    socket.on('request.eta', refetchList);
    // 다른 PC 응답·만료·닫힘으로 요청이 끝나면 목록·알림을 내리고, 열린 상세도 '끝난 요청'으로 바꾼다
    socket.on('request.changed', refetchAll);
    // 재연결 때는 놓친 게 있을 수 있어 항상 전체를 다시 받는다 (실시간 설계 B)
    socket.on('connect', refetchAll);
    return () => {
      socket.off('request.new', onNew);
      socket.off('request.updated', onUpdated);
      socket.off('request.eta', refetchList);
      socket.off('request.changed', refetchAll);
      socket.off('connect', refetchAll);
    };
  }, [socket, queryClient]);

  const waiting = useMemo(
    () =>
      (requests.data?.items ?? [])
        .filter((r) => r.status === 'waiting')
        .map(toOverlay)
        .filter((r): r is OverlayRequest => r !== null)
        .sort((a, b) => Date.parse(a.respondUntil) - Date.parse(b.respondUntil)),
    [requests.data],
  );

  useTabTitleAlert(waiting.length);

  // 새로 들어온 요청을 작은 알림(토스트)으로 띄운다. 요청마다 1번만.
  // '새로 온 것' = 이 탭이 request.new 로 받은 요청. 화면을 열 때 이미 있던 요청은 목록·깜빡임으로 보인다.
  // 이벤트에는 번호만 있으니(절대 규칙 5) 목록을 받은 뒤 그 요청의 내용으로 띄운다
  const toasted = useRef(new Set<number>());
  const [toasts, setToasts] = useState<OverlayRequest[]>([]);
  useEffect(() => {
    const fresh = waiting.filter((r) => arrived.current.has(r.id) && !toasted.current.has(r.id));
    if (fresh.length === 0) return;
    fresh.forEach((r) => toasted.current.add(r.id));
    // 최신이 맨 위, 많아도 3개까지만 쌓는다
    setToasts((prev) => [...fresh, ...prev].slice(0, TOAST_LIMIT));
  }, [waiting]);
  const dismissToast = useCallback(
    (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );
  // 다른 PC 응답·만료로 끝난 요청의 알림은 바로 내린다
  const visibleToasts = useMemo(() => {
    const ids = new Set(waiting.map((r) => r.id));
    return toasts.filter((t) => ids.has(t.id));
  }, [toasts, waiting]);

  const items = useMemo(() => requests.data?.items ?? [], [requests.data]);

  // 목록에 요청이 있는 동안만 1초마다 서버 기준 시각을 다시 계산한다 (남은 시간 표시)
  const offsetMs = requests.data?.offsetMs ?? 0;
  const hasItems = items.length > 0;
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (!hasItems) return;
    const tick = () => setNowMs(Date.now() + offsetMs);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [hasItems, offsetMs]);

  return { items, waiting, nowMs, toasts: visibleToasts, dismissToast };
}
