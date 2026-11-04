import type { components, paths } from './schema';

export type ApiPaths = paths;
export type ApiErrorBody = components['schemas']['Error'];

// 서버가 4xx·5xx 를 주면 이 오류를 던진다. 화면은 code 로 문구를 고른다 (오류 코드표: 4_API명세.md).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// 서버에 닿지 못했을 때(서버 꺼짐·네트워크 끊김)
export const NETWORK_ERROR = 'NETWORK_ERROR';

// 항상 같은 사이트의 /api/v1 로 부른다. 병원 PC 쿠키(st_pc)가 SameSite=Strict 라서
// 다른 주소로 부르면 쿠키가 따라가지 않는다 (T-03). 개발 중에는 next.config 가 서버(4000)로 넘겨준다.
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiError(0, NETWORK_ERROR, '서버에 연결할 수 없어요');
  }

  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? '잠시 후 다시 시도해 주세요',
      (error?.details as Record<string, unknown> | null | undefined) ?? null,
    );
  }
  return body as T;
}
