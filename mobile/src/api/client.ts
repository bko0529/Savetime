/**
 * 세이브타임 서버 연결 (REST, openapi.yaml 기준 /api/v1).
 * - 서버 주소는 EXPO_PUBLIC_API_BASE_URL, 없으면 노트북 개발 서버(http://localhost:4000)
 * - 로그인 토큰(15분)이 만료돼 401 이 오면 refresh 토큰으로 한 번만 갱신하고 다시 보낸다
 * - 응답 헤더 X-Server-Now 로 서버 시각과의 차이를 기억한다 → 2분·5분 남은 시간은 serverNow() 로 계산
 * - 오류는 서버의 { error: { code, message, details } } 를 ApiError 로 바꿔 던진다. message 는 화면에 그대로 보여도 되는 한국어
 */
import type { components } from './schema';

export type Tokens = components['schemas']['Tokens'];
export type Me = components['schemas']['Me'];

export const API_BASE_URL: string = (
  process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:4000'
).replace(/\/$/, '');

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

/**
 * 토큰을 어디에 두는지는 auth 쪽이 정한다 (refresh 는 secure-store).
 * 이 파일은 꺼내 쓰고, 새로 받은 값을 돌려주기만 한다 → 테스트에서 가짜로 바꾸기 쉽다.
 */
export type TokenHooks = {
  get: () => Tokens | null;
  set: (t: Tokens) => void | Promise<void>;
  /** refresh 도 실패 = 근무가 끝났거나 정지됨 → 로그인 화면으로 */
  lost: () => void;
};
let hooks: TokenHooks = { get: () => null, set: () => {}, lost: () => {} };
export function setTokenHooks(h: TokenHooks) {
  hooks = h;
}

// ---- 서버 시각 (규칙 6: 시간 판정은 서버 기준) ----
let clockOffset = 0;
/** 서버 기준 지금(ms). 휴대폰 시계가 틀려도 남은 시간이 서버와 같게 보인다 */
export const serverNow = () => Date.now() + clockOffset;
export function noteServerTime(iso: string | null | undefined) {
  if (!iso) return;
  const t = Date.parse(iso);
  if (!Number.isNaN(t)) clockOffset = t - Date.now();
}

// ---- refresh: 동시에 여러 요청이 401 을 받아도 갱신은 한 번만 ----
// 갱신할 때마다 refresh 토큰이 새 값으로 바뀌고 예전 값은 못 쓰기 때문에, 두 번 보내면 두 번째가 실패한다
let refreshing: Promise<boolean> | null = null;
export function refreshTokens(): Promise<boolean> {
  const t = hooks.get();
  if (!t?.refreshToken) return Promise.resolve(false);
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: t.refreshToken }),
      });
      if (!res.ok) return false;
      await hooks.set((await res.json()) as Tokens);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** 실시간 연결이 TOKEN_EXPIRED 로 거절됐을 때: 토큰을 새로 받고, 안 되면 로그인 화면으로 */
export async function ensureFreshToken(): Promise<boolean> {
  const ok = await refreshTokens();
  if (!ok) hooks.lost();
  return ok;
}

/** 지금 access 토큰 (실시간 연결에 씀) */
export const currentAccessToken = () => hooks.get()?.accessToken ?? null;

type Options = {
  body?: unknown;
  /** 사진을 보내는 multipart 요청 (가입 신청). Content-Type 은 fetch 가 경계값과 함께 직접 붙인다 */
  form?: FormData;
  auth?: boolean;
};

export async function api<T = unknown>(
  method: string,
  path: string,
  opt: Options = {},
  retried = false,
): Promise<T> {
  const auth = opt.auth ?? true;
  const headers: Record<string, string> = {};
  if (opt.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = hooks.get()?.accessToken;
  if (auth && token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/v1${path}`, {
      method,
      headers,
      body: opt.form ?? (opt.body !== undefined ? JSON.stringify(opt.body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요');
  }
  noteServerTime(res.headers.get('X-Server-Now'));

  // 401 = 토큰 만료. 로그인 요청(auth: false)은 갱신하지 않는다 (비밀번호가 틀린 것일 뿐)
  if (res.status === 401 && auth && !retried) {
    if (await refreshTokens()) return api<T>(method, path, opt, true);
    hooks.lost();
  }

  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (
      data as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> | null };
      } | null
    )?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'UNKNOWN',
      e?.message ?? '잠시 후 다시 시도해 주세요',
      e?.details,
    );
  }
  return data as T;
}
