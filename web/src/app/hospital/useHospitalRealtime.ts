'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createHospitalSocket, type HospitalSocket } from '@/lib/realtime/hospitalSocket';

export type Connection = 'connecting' | 'connected' | 'disconnected';

// 병원 PC 1대의 실시간 연결 (SFR-117, 실시간 설계 2장).
// 예전에는 사람이 '알림 켜기'를 눌러야 요청을 받았다(브라우저 소리 정책 때문).
// 이제 소리를 쓰지 않으므로 누를 필요가 없다. 근무 중이고 연결되면 이 탭을 자동으로 '요청 받는 탭'으로 등록한다.
export function useHospitalRealtime(
  createSocket: () => HospitalSocket = createHospitalSocket,
  // 진행 중인 근무 id (GET /hw/session). null 이면 근무 전이라 등록하지 않는다
  shiftId: number | null,
) {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<Connection>('connecting');
  // 새 요청 받기(useNewRequests) 등이 같은 연결을 쓰도록 밖으로 내보낸다
  const [socket, setSocket] = useState<HospitalSocket | null>(null);
  // 서버가 등록을 풀었을 때(응답 없음 등) 다시 등록하려고 숫자를 올린다
  const [attempt, setAttempt] = useState(0);
  // 최신 함수를 소켓 처리기 안에서 쓰려고 ref 에 둔다 (처리기를 다시 달지 않으려고)
  const sessionChanged = useRef(() => {
    void queryClient.invalidateQueries({ queryKey: ['hw', 'session'] });
  });

  useEffect(() => {
    const socket = createSocket();
    setSocket(socket);

    const onConnect = () => setConnection('connected');
    const onDisconnect = () => setConnection('disconnected');
    const onAlarmOff: Parameters<typeof socket.on<'hospital.alarm_off'>>[1] = (e) => {
      // 근무가 끝났으면 근무 정보를 다시 받는다 (근무 시작 화면으로)
      if (e.data.reason === 'shift_ended') sessionChanged.current();
      // 그 밖(응답 없음 등)은 사람이 할 일 없이 곧바로 다시 등록한다
      else setAttempt((n) => n + 1);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    socket.on('hospital.alarm_off', onAlarmOff);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
      socket.off('hospital.alarm_off', onAlarmOff);
      socket.disconnect();
      setSocket(null);
    };
  }, [createSocket]);

  // 근무 중 + 연결됨 → 서버에 '이 탭이 요청을 받아요'라고 등록한다 (다시 연결될 때마다 새로).
  // 서버는 근무 id 가 이 PC 의 진행 중 근무인지 DB 에서 확인하고, 탭이 끊기면 스스로 등록을 푼다.
  // 등록 여부는 서버(DB)가 기억한다. 탭 메모리에 따로 두지 않는다 (절대 규칙 7)
  useEffect(() => {
    if (!socket || connection !== 'connected' || shiftId === null) return;
    socket.emit('alarm.resume', { shiftId }, ({ ok }) => {
      // 거부 = 그 근무가 이미 끝났다. 근무 정보를 다시 받아 화면을 맞춘다
      if (!ok) sessionChanged.current();
    });
  }, [socket, connection, shiftId, attempt]);

  return { socket, connection };
}
