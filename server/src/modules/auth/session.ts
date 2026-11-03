// 요청마다 계정 상태 확인 (SER-016). 정지·로그아웃은 접근 토큰이 아직 살아 있어도 바로 막아야 한다.
// 매 요청 DB를 보면 느려서 Redis에 잠깐 담아 두고, 서버 여러 대가 같은 값을 본다 (서버 메모리에 두지 않음).
import type { Redis } from 'ioredis';
import type pg from 'pg';

// 캐시를 지우지 못해도(Redis 장애 등) 이 시간이 지나면 DB 값을 다시 읽는다. 목표: 정지 후 10초 안에 거부
const CACHE_SECONDS = 10;

export type ParamedicStatus = 'pending' | 'approved' | 'rejected' | 'suspended' | 'withdrawn';

export interface SessionState {
  sessionVersion: number;
  status: ParamedicStatus;
}

export interface AuthContext {
  pool: pg.Pool;
  redis: Redis;
  jwtKey: Uint8Array;
  shiftHours: number;
}

const cacheKey = (paramedicId: string) => `auth:paramedic:${paramedicId}`;

export async function loadSessionState(
  ctx: Pick<AuthContext, 'pool' | 'redis'>,
  paramedicId: string,
): Promise<SessionState | undefined> {
  try {
    const cached = await ctx.redis.get(cacheKey(paramedicId));
    if (cached) return JSON.parse(cached) as SessionState;
  } catch {
    // Redis가 안 되면 DB로 확인한다. 확인을 건너뛰고 통과시키지 않는다.
  }

  const { rows } = await ctx.pool.query<{ session_version: number; status: ParamedicStatus }>(
    'SELECT session_version, status FROM paramedic WHERE id = $1',
    [paramedicId],
  );
  if (!rows[0]) return undefined;
  const state = { sessionVersion: rows[0].session_version, status: rows[0].status };
  await ctx.redis
    .set(cacheKey(paramedicId), JSON.stringify(state), 'EX', CACHE_SECONDS)
    .catch(() => {});
  return state;
}

// 정지·로그아웃·근무 종료 때 부른다: 세션 번호를 올려 접근 토큰을 무효로 하고, 갱신 토큰도 모두 폐기한다.
// 실시간 연결 끊기는 실시간 모듈이 생기면(S3) 여기에 붙인다.
export async function endSessions(
  ctx: Pick<AuthContext, 'redis'>,
  db: pg.Pool | pg.PoolClient,
  paramedicId: string,
): Promise<void> {
  await db.query('UPDATE paramedic SET session_version = session_version + 1 WHERE id = $1', [
    paramedicId,
  ]);
  await db.query(
    `UPDATE refresh_token SET revoked_at = now()
      WHERE owner_type = 'paramedic' AND owner_id = $1 AND revoked_at IS NULL`,
    [paramedicId],
  );
  await forgetSessionState(ctx, paramedicId);
}

// 트랜잭션 안에서 endSessions를 불렀다면 커밋한 뒤에 한 번 더 부른다.
// 커밋 전에 지우면 그사이 다른 요청이 옛 값을 다시 캐시에 넣을 수 있다.
export async function forgetSessionState(
  ctx: Pick<AuthContext, 'redis'>,
  paramedicId: string,
): Promise<void> {
  await ctx.redis.del(cacheKey(paramedicId)).catch(() => {});
}
