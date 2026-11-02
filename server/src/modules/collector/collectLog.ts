// 수집 실패 기록 (SFR-023). 세 가지 수집이 같은 방식으로 실패를 남긴다.
import type pg from 'pg';
import type { Logger } from 'pino';
import { CollectError } from './publicApi.js';

export type CollectKind = 'beds' | 'hospitals' | 'capabilities';

// 기록까지 실패해도 다른 시·도는 계속 수집해야 하므로 오류를 밖으로 던지지 않는다.
export async function recordFailure(
  pool: pg.Pool,
  logger: Logger,
  kind: CollectKind,
  region: string,
  startedAt: Date,
  err: unknown,
): Promise<string> {
  const code = err instanceof CollectError ? err.code : 'SAVE_FAILED';
  if (code === 'SAVE_FAILED') {
    logger.error({ kind, region, message: (err as Error).message }, '수집 저장 실패');
  }
  try {
    await pool.query(
      `INSERT INTO collect_log (kind, region, started_at, finished_at, success, error_code)
       VALUES ($1, $2, $3, now(), false, $4)`,
      [kind, region, startedAt, code],
    );
  } catch (saveErr) {
    logger.error({ kind, region, message: (saveErr as Error).message }, '수집 실패 기록 실패');
  }
  return code;
}
