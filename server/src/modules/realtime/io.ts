// Socket.IO 서버 (실시간 설계 2장). 바꾸는 일은 REST, 알려 주는 일만 웹소켓으로 한다.
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server } from 'socket.io';

// ping 5초 + 응답 대기 5초 → 끊김을 10초 안에 알아챈다 (INR-003)
export const PING_INTERVAL_MS = 5_000;
export const PING_TIMEOUT_MS = 5_000;

export interface Realtime {
  io: Server;
  close: () => Promise<void>;
}

// http 서버 없이 먼저 만들고, 서버를 켠 뒤 io.attach(server) 로 붙인다.
// 그래야 Express 라우터(알림 켜기 등)가 시작할 때부터 io 를 받아 쓸 수 있다.
export function createRealtime({
  redis,
  keyPrefix,
}: {
  redis: Redis;
  keyPrefix?: string;
}): Realtime {
  // 서버가 2대가 되면 1번 서버에 붙은 PC 에 2번 서버도 보낼 수 있어야 한다.
  // Redis 어댑터가 방 보내기·방 넣고 빼기를 다른 서버에도 전해 준다 (T-08)
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  const io = new Server({
    // 처음부터 웹소켓으로만 받는다. 긴 폴링을 안 쓰면 로드밸런서 세션 고정이 필요 없다 (T-08)
    transports: ['websocket'],
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: PING_TIMEOUT_MS,
    // 브라우저 Origin 검사는 네임스페이스마다 직접 한다 (병원 웹은 쿠키로 들어오므로 꼭 필요)
    serveClient: false,
    adapter: createAdapter(pub, sub, { key: keyPrefix ?? 'socket.io' }),
  });

  // 기본 네임스페이스(/)는 쓰지 않는다. 인증 없이 붙어 있는 연결이 생기지 않게 막는다
  io.use((_socket, next) => next(new Error('NOT_FOUND')));

  return {
    io,
    // 붙어 있는 연결을 끊는다. 웹소켓이 열려 있으면 http 서버가 닫히지 않는다.
    // 끊긴 브라우저는 다른 서버로 다시 붙는다 (서버 1대씩 교체 배포, COR-016)
    close: async () => {
      io.disconnectSockets(true);
      // 어댑터가 처음에 보낸 구독 명령이 끝나기 전에 닫으면 그 명령이 실패한다.
      // ping 은 앞 명령들 뒤에 줄을 서므로, ping 이 돌아오면 닫아도 된다
      await Promise.allSettled([pub.ping(), sub.ping()]);
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
