// 수집 실패 기록 (SFR-023). 세 가지 수집이 같은 방식으로 실패를 남긴다.
// 같은 수집·같은 시·도가 3번 연속 실패하면 관리자 알림을 1건 남긴다 (QUR-008, SFR-100 ①)
import type pg from 'pg';
import type { Logger } from 'pino';
import { notifyAdmin } from '../admin/notifications.js';
import { CollectError } from './publicApi.js';

export const FAIL_STREAK_ALERT = 3;

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
  // 호출 한도로 멈춘 것은 고장이 아니라서 세지 않는다. 한도 알림은 따로 간다 (SFR-090)
  if (code !== 'QUOTA_EXCEEDED') {
    try {
      if (await streakJustReached(pool, kind, region)) {
        logger.error({ kind, region, streak: FAIL_STREAK_ALERT }, '수집 연속 실패');
        await notifyAdmin(pool, 'collect_fail', null);
      }
    } catch (alertErr) {
      logger.error({ kind, region, message: (alertErr as Error).message }, '수집 실패 알림 실패');
    }
  }
  return code;
}

// 최근 기록이 '실패 3번'이고 그 앞은 실패가 아닐 때만 true: 실패가 계속 이어져도 3번째에 한 번만 알린다.
// (실패가 멈췄다가 다시 3번 이어지면 또 알린다. 30분 안이면 notifyAdmin 이 횟수만 올린다)
async function streakJustReached(
  pool: pg.Pool,
  kind: CollectKind,
  region: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ failed: boolean }>(
    `SELECT NOT success AND error_code IS DISTINCT FROM 'QUOTA_EXCEEDED' AS failed
       FROM collect_log
      WHERE kind = $1 AND region = $2
      ORDER BY started_at DESC, id DESC
      LIMIT $3`,
    [kind, region, FAIL_STREAK_ALERT + 1],
  );
  const recent = rows.slice(0, FAIL_STREAK_ALERT);
  return (
    recent.length === FAIL_STREAK_ALERT &&
    recent.every((r) => r.failed) &&
    rows[FAIL_STREAK_ALERT]?.failed !== true
  );
}
