/**
 * 실시간 연결 (Socket.IO /app). Lovable realtime.ts 를 그대로 옮겼다.
 * 서버가 '먼저 알려 주는' 일만 받는다 (상태 바꾸기는 REST).
 * - 웹소켓만 쓴다 (서버 설정과 같게)
 * - 이벤트는 { seq, occurredAt, serverNow, entityVersion?, data }. 마지막 seq 를 기억했다가 다시 붙으면 'sync' 로 놓친 것을 받는다
 * - 토큰이 만료돼 거절되면(TOKEN_EXPIRED) 토큰을 갱신하고 다시 붙는다
 * 이벤트에는 ID·개수·시각만 온다 (규칙 5). 화면에 필요한 상세는 받은 뒤 REST 로 다시 읽는다
 */
import { io, type Socket } from 'socket.io-client';
import type { AppServerEvents, Envelope as SharedEnvelope } from '../../../shared/events';
import { API_BASE_URL, currentAccessToken, ensureFreshToken, noteServerTime } from '../api/client';

export type Envelope<T = Record<string, unknown>> = SharedEnvelope<T>;
export type AppEventName = keyof AppServerEvents | 'snapshot_required';
/** 이벤트 이름 → data 모양 (shared/events.ts 에서 꺼냄) */
export type EventData<N extends AppEventName> = N extends keyof AppServerEvents
  ? Parameters<AppServerEvents[N]>[0] extends SharedEnvelope<infer D>
    ? D
    : never
  : Record<string, never>;

type Handler = (e: Envelope<any>) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

let socket: Socket | null = null;
let lastSeq: number | null = null;
const handlers = new Map<string, Set<Handler>>();

/** 이벤트 듣기. 돌려준 함수를 부르면 그만 듣는다 */
export function onEvent<N extends AppEventName>(
  name: N,
  fn: (e: Envelope<EventData<N>>) => void,
): () => void {
  let set = handlers.get(name);
  if (!set) handlers.set(name, (set = new Set()));
  set.add(fn as Handler);
  return () => void set!.delete(fn as Handler);
}

/**
 * 받아서 처리할 이벤트인지. 이미 받은 번호(다시 보내기와 겹침)는 버린다.
 * 번호가 0 인 이벤트(강제 로그아웃 등)는 기록 없이 바로 보내는 것이라 늘 받고, 마지막 번호도 바꾸지 않는다
 */
export function acceptSeq(
  last: number | null,
  seq: unknown,
): { accept: boolean; last: number | null } {
  if (typeof seq !== 'number' || seq <= 0) return { accept: true, last };
  if (last !== null && seq <= last) return { accept: false, last };
  return { accept: true, last: seq };
}

/** 테스트에서도 쓰려고 꺼내 둠: 이벤트 1개를 처리 */
export function dispatch(name: string, env: Envelope) {
  const r = acceptSeq(lastSeq, env?.seq);
  if (!r.accept) return;
  lastSeq = r.last;
  noteServerTime(env?.serverNow);
  handlers.get(name)?.forEach((f) => f(env));
}

export function connectRealtime() {
  if (socket) return;
  socket = io(`${API_BASE_URL}/app`, {
    transports: ['websocket'],
    auth: (cb) => cb({ token: currentAccessToken() }),
    reconnectionDelayMax: 5000,
  });
  socket.on('connect', () => {
    // 끊긴 동안 놓친 이벤트를 받는다. 너무 오래 끊겼으면 snapshotRequired → 화면이 REST 로 다시 읽는다
    socket?.emit(
      'sync',
      { lastSeq },
      (r: { snapshotRequired?: boolean; latestSeq?: number } | undefined) => {
        if (r?.snapshotRequired) {
          if (typeof r.latestSeq === 'number') lastSeq = r.latestSeq;
          handlers
            .get('snapshot_required')
            ?.forEach((f) => f({ seq: 0, room: '', occurredAt: '', serverNow: '', data: {} }));
        }
      },
    );
  });
  socket.on('connect_error', async (err) => {
    if (err.message === 'TOKEN_EXPIRED' && (await ensureFreshToken())) socket?.connect();
  });
  socket.onAny((name: string, env: Envelope, ack?: unknown) => {
    dispatch(name, env);
    // 받았음 확인이 필요한 이벤트는 서버가 ack 함수를 준다
    if (typeof ack === 'function') (ack as () => void)();
  });
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  lastSeq = null;
}

/** 팀이 바뀌어 들어갈 방이 달라졌을 때 다시 붙는다 (서버가 연결할 때 방을 정함) */
export function reconnectRealtime() {
  if (!socket) return;
  socket.disconnect().connect();
}
