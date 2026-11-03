// 관리자 알림 쌓기. 같은 종류·같은 대상이 30분 안에 또 생기면 새로 만들지 않고 횟수만 올린다 (SFR-147 등)
import type pg from 'pg';

export type AdminNotificationKind =
  'collect_fail' | 'signup' | 'pc_change' | 'key_expiring' | 'odd_pc' | 'api_quota' | 'integrity';

const MERGE_MINUTES = 30;

export async function notifyAdmin(
  db: pg.Pool | pg.PoolClient,
  kind: AdminNotificationKind,
  refId: number | string | null,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE admin_notification
        SET occurrences = occurrences + 1, last_at = now(), read_at = NULL
      WHERE id = (SELECT id FROM admin_notification
                   WHERE kind = $1 AND ref_id IS NOT DISTINCT FROM $2
                     AND last_at > now() - make_interval(mins => $3)
                   ORDER BY last_at DESC LIMIT 1)`,
    [kind, refId, MERGE_MINUTES],
  );
  if (rowCount === 0) {
    await db.query('INSERT INTO admin_notification (kind, ref_id) VALUES ($1, $2)', [kind, refId]);
  }
}
