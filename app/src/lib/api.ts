/**
 * 세이브타임 서버 연결 (REST). 서버 주소는 VITE_API_BASE_URL, 없으면 노트북 시연 서버(http://localhost:4000).
 * - 로그인 토큰(15분)이 만료되면 refresh 토큰으로 한 번 갱신하고 다시 보낸다
 * - 응답 헤더 X-Server-Now 로 서버 시각과의 차이를 기억한다 → 2분·5분 남은 시간은 serverNow() 로 계산 (SFR-110)
 * - 오류는 서버의 { error: { code, message, details } } 를 ApiError 로 바꿔 던진다. message 는 그대로 화면에 보여도 되는 한국어
 */

export const API_BASE_URL: string =
  (import.meta.env["VITE_API_BASE_URL"] as string | undefined)?.replace(/\/$/, "") ||
  "http://localhost:4000";

export type Tokens = { accessToken: string; refreshToken: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

// ---- 토큰: auth-store 가 저장하고, 여기서는 꺼내 쓰고 갱신된 값을 돌려준다 ----
type TokenHooks = {
  get: () => Tokens | null;
  set: (t: Tokens) => void;
  /** refresh 도 실패 = 근무가 끝났거나 정지됨 → 로그인 화면으로 */
  lost: () => void;
};
let hooks: TokenHooks = { get: () => null, set: () => {}, lost: () => {} };
export const setTokenHooks = (h: TokenHooks) => {
  hooks = h;
};

// ---- 서버 시각 ----
let clockOffset = 0;
/** 서버 기준 지금(ms). 휴대폰 시계가 틀려도 남은 시간이 서버와 같게 보인다 */
export const serverNow = () => Date.now() + clockOffset;
export function noteServerTime(iso: string | null | undefined) {
  if (!iso) return;
  const t = Date.parse(iso);
  if (!Number.isNaN(t)) clockOffset = t - Date.now();
}

// ---- 이 설치를 구별하는 ID (로그인·위치 담당 단말에 쓴다). 개인 정보 아님 ----
const DEVICE_KEY = "savetime-device-id";
export function deviceId(): string {
  if (typeof window === "undefined") return "ssr";
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `web-${crypto.randomUUID()}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "web-no-storage";
  }
}

type Options = {
  body?: unknown;
  form?: FormData;
  auth?: boolean;
  headers?: Record<string, string>;
};

let refreshing: Promise<boolean> | null = null;
async function refreshTokens(): Promise<boolean> {
  const t = hooks.get();
  if (!t) return false;
  // 동시에 여러 요청이 401 을 받아도 갱신은 한 번만 (갱신할 때마다 refresh 토큰이 바뀐다)
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: t.refreshToken }),
      });
      if (!res.ok) return false;
      hooks.set((await res.json()) as Tokens);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

/** 토큰을 새로 받아야 할 때 (실시간 연결이 TOKEN_EXPIRED 로 거절됐을 때 등) */
export async function ensureFreshToken(): Promise<boolean> {
  const ok = await refreshTokens();
  if (!ok) hooks.lost();
  return ok;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  opt: Options = {},
  retried = false,
): Promise<T> {
  const auth = opt.auth ?? true;
  const headers: Record<string, string> = { ...opt.headers };
  if (opt.body !== undefined) headers["Content-Type"] = "application/json";
  const token = hooks.get()?.accessToken;
  if (auth && token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    const body = opt.form ?? (opt.body !== undefined ? JSON.stringify(opt.body) : null);
    res = await fetch(`${API_BASE_URL}/api/v1${path}`, { method, headers, body });
  } catch {
    throw new ApiError(0, "NETWORK", "서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요");
  }
  noteServerTime(res.headers.get("X-Server-Now"));

  if (res.status === 401 && auth && !retried && hooks.get()) {
    if (await refreshTokens()) return api<T>(method, path, opt, true);
    hooks.lost();
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(
      res.status,
      e?.code ?? `HTTP_${res.status}`,
      e?.message ?? "잠시 뒤 다시 해 주세요",
      e?.details ?? null,
    );
  }
  return json as T;
}

/** 오류를 화면 문구로 */
export const errorText = (e: unknown) =>
  e instanceof ApiError ? e.message : "알 수 없는 오류가 났어요";
