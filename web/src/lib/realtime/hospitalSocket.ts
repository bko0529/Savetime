import { io, type Socket } from 'socket.io-client';
import type { HospitalClientEvents, HospitalServerEvents } from '@shared/events';

export type HospitalSocket = Socket<HospitalServerEvents, HospitalClientEvents>;

// 병원 웹 실시간 연결 (/hospital 네임스페이스). 서버가 등록 PC 쿠키(st_pc)로 어느 PC 인지 알아낸다.
// - 처음부터 웹소켓으로만 붙는다: 서버가 2대가 돼도 한 서버에 고정할 필요가 없다 (T-08)
// - 운영에서는 같은 도메인, 개발 중에는 NEXT_PUBLIC_SOCKET_ORIGIN(예: http://localhost:4000)으로 바로 붙는다.
//   포트만 다른 localhost 는 같은 사이트라서 SameSite=Strict 쿠키도 같이 간다.
export function createHospitalSocket(): HospitalSocket {
  const origin = process.env.NEXT_PUBLIC_SOCKET_ORIGIN ?? '';
  return io(`${origin}/hospital`, {
    transports: ['websocket'],
    withCredentials: true,
    autoConnect: false,
  });
}
