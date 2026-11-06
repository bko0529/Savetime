'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';

// 관리자가 키를 폐기·재발급하거나 병원 계정을 정지하면 서버가 pc.revoked 를 보낸다 (SFR-146, SFR-123).
// 이벤트에는 이유만 있으니, 'PC 누구야?'(GET /hw/session)를 다시 물어 서버 판단을 따른다:
// PC 등록이 풀렸으면 키 입력 화면으로, 정지면 정지 안내로 간다 (HospitalHome)
export function usePcRevoked(socket: HospitalSocket | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!socket) return;
    const onRevoked = () => {
      void queryClient.invalidateQueries({ queryKey: ['hw', 'session'] });
    };
    socket.on('pc.revoked', onRevoked);
    return () => {
      socket.off('pc.revoked', onRevoked);
    };
  }, [socket, queryClient]);
}
