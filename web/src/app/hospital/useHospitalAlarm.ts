'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { unlockSound, askNotificationPermission } from '@/lib/alarm/browserAlarm';
import { ApiError, apiFetch, NETWORK_ERROR, type ApiPaths } from '@/lib/api/client';
import { createHospitalSocket, type HospitalSocket } from '@/lib/realtime/hospitalSocket';

type AlarmOnResult =
  ApiPaths['/hw/shifts/current/alarm-on']['post']['responses'][200]['content']['application/json'];

export type Connection = 'connecting' | 'connected' | 'disconnected';
export type AlarmState =
  | { kind: 'off' }
  | { kind: 'on'; shiftId: number }
  | { kind: 'turned_off'; reason: 'no_ack' | 'shift_ended' | 'resume_failed' };

// 병원 PC 1대의 실시간 연결과 '알림 켜기' 상태 (SFR-117, 실시간 설계 2장)
export function useHospitalAlarm(createSocket: () => HospitalSocket = createHospitalSocket) {
  const queryClient = useQueryClient();
  const socketRef = useRef<HospitalSocket | null>(null);
  // shiftId 는 이 탭 메모리에만 둔다. 연결만 끊겼다 붙으면 이걸로 자동 복구하고,
  // 새로고침하면 사라지므로 사람이 다시 눌러야 한다 (브라우저 소리 정책, D-96)
  const shiftIdRef = useRef<number | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [alarm, setAlarm] = useState<AlarmState>({ kind: 'off' });
  // 새 요청 받기(useNewRequests)가 같은 연결을 쓰도록 밖으로 내보낸다
  const [socket, setSocket] = useState<HospitalSocket | null>(null);

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;
    setSocket(socket);

    const onConnect = () => {
      setConnection('connected');
      const shiftId = shiftIdRef.current;
      if (shiftId === null) return;
      socket.emit('alarm.resume', { shiftId }, ({ ok }) => {
        if (ok) {
          setAlarm({ kind: 'on', shiftId });
        } else {
          shiftIdRef.current = null;
          setAlarm({ kind: 'turned_off', reason: 'resume_failed' });
        }
      });
    };
    const onDisconnect = () => setConnection('disconnected');
    const onAlarmOff: Parameters<typeof socket.on<'hospital.alarm_off'>>[1] = (e) => {
      shiftIdRef.current = null;
      setAlarm({ kind: 'turned_off', reason: e.data.reason });
      // 근무가 끝났으면 서버의 근무 정보도 바뀌었으니 다시 받는다
      if (e.data.reason === 'shift_ended') {
        void queryClient.invalidateQueries({ queryKey: ['hw', 'session'] });
      }
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
      socketRef.current = null;
      setSocket(null);
    };
  }, [createSocket, queryClient]);

  const turnOn = useMutation({
    mutationFn: async () => {
      // 버튼을 누른 바로 그 순간에 해야 브라우저가 허락한다. 권한 창은 기다리지 않는다
      void askNotificationPermission();
      await unlockSound();
      const socketId = socketRef.current?.id;
      if (!socketId) throw new ApiError(0, NETWORK_ERROR, '실시간 연결이 아직 안 됐어요');
      return apiFetch<AlarmOnResult>('/hw/shifts/current/alarm-on', {
        method: 'POST',
        body: JSON.stringify({ socketId }),
      });
    },
    onSuccess: ({ shiftId }) => {
      if (typeof shiftId !== 'number') return;
      shiftIdRef.current = shiftId;
      setAlarm({ kind: 'on', shiftId });
    },
  });

  return { socket, connection, alarm, turnOn };
}
