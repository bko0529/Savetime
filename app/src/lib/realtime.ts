/**
 * 세이브타임 실시간 연결 (Socket.IO /app). 서버가 '먼저 알려 주는' 일만 받는다 (상태 바꾸기는 REST, api.ts).
 * - 웹소켓만 쓴다 (서버 설정과 같게)
 * - 이벤트는 { seq, occurredAt, serverNow, entityVersion?, data } 모양. 마지막 seq 를 기억했다가 다시 붙으면 'sync' 로 놓친 것을 받는다
 * - 토큰이 만료돼 거절되면(TOKEN_EXPIRED) 토큰을 갱신하고 다시 붙는다
 * 이벤트에는 ID·개수·시각만 온다. 화면에 필요한 상세는 받은 뒤 REST 로 다시 읽는다
 */
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL, ensureFreshToken, noteServerTime } from "./api";

export type Envelope<T = Record<string, unknown>> = {
  seq: number;
  room: string;
  occurredAt: string;
  serverNow: string;
  entityVersion?: number;
  data: T;
};
type Handler = (e: Envelope) => void;

let socket: Socket | null = null;
let lastSeq: number | null = null;
let getToken: () => string | null = () => null;
const handlers = new Map<string, Set<Handler>>();
const statusSubs = new Set<(connected: boolean) => void>();

/** 이벤트 듣기. 돌려준 함수를 부르면 그만 듣는다 */
export function onEvent(name: string, fn: Handler): () => void {
  let set = handlers.get(name);
  if (!set) handlers.set(name, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

/** 연결 상태 듣기 (끊기면 화면에 '연결 끊김' 표시용) */
export function onConnection(fn: (connected: boolean) => void): () => void {
  statusSubs.add(fn);
  return () => statusSubs.delete(fn);
}

/**
 * 받아서 처리할 이벤트인지. 이미 받은 번호(다시 보내기와 겹침)는 버린다.
 * 번호가 0 인 이벤트(강제 로그아웃·PC 해제 등)는 기록 없이 바로 보내는 것이라 늘 받고, 마지막 번호도 바꾸지 않는다
 */
export function acceptSeq(last: number | null, seq: unknown): { accept: boolean; last: number | null } {
  if (typeof seq !== "number" || seq <= 0) return { accept: true, last };
  if (last !== null && seq <= last) return { accept: false, last };
  return { accept: true, last: seq };
}

function dispatch(name: string, env: Envelope) {
  const r = acceptSeq(lastSeq, env?.seq);
  if (!r.accept) return;
  lastSeq = r.last;
  noteServerTime(env?.serverNow);
  handlers.get(name)?.forEach((f) => f(env));
  handlers.get("*")?.forEach((f) => f({ ...env, room: `${env.room}#${name}` }));
}

export function connectRealtime(tokenGetter: () => string | null) {
  if (typeof window === "undefined") return;
  getToken = tokenGetter;
  if (socket) return;
  socket = io(`${API_BASE_URL}/app`, {
    transports: ["websocket"],
    auth: (cb) => cb({ token: getToken() }),
    reconnectionDelayMax: 5000,
  });
  socket.on("connect", () => {
    statusSubs.forEach((f) => f(true));
    // 끊긴 동안 놓친 이벤트를 받는다. 너무 오래 끊겼으면 snapshotRequired → 화면이 REST 로 다시 읽는다
    socket?.emit(
      "sync",
      { lastSeq },
      (r: { snapshotRequired?: boolean; latestSeq?: number } | undefined) => {
        if (r?.snapshotRequired) {
          if (typeof r.latestSeq === "number") lastSeq = r.latestSeq;
          handlers
            .get("snapshot_required")
            ?.forEach((f) => f({ seq: 0, room: "", occurredAt: "", serverNow: "", data: {} }));
        }
      },
    );
  });
  socket.on("disconnect", () => statusSubs.forEach((f) => f(false)));
  socket.on("connect_error", async (err) => {
    if (err.message === "TOKEN_EXPIRED" && (await ensureFreshToken())) socket?.connect();
  });
  socket.onAny((name: string, env: Envelope, ack?: unknown) => {
    dispatch(name, env);
    // 받았음 확인이 필요한 이벤트는 서버가 ack 함수를 준다
    if (typeof ack === "function") (ack as () => void)();
  });
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  lastSeq = null;
}

/** 팀이 바뀌는 등 토큰·방이 달라졌을 때 다시 붙는다 */
export function reconnectRealtime() {
  if (!socket) return;
  socket.disconnect().connect();
}
