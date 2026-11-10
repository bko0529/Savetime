// 관리자 알림 (SFR-100). 같은 종류·같은 대상이 30분 안에 또 생기면 새로 만들지 않고 횟수만 올린다.
// 알림 행에는 종류·대상 id·횟수·시각만 둔다. 화면 문구는 읽을 때 병원·PC·키 표에서 만든다 (DB 칸을 늘리지 않으려고)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { BURST_COUNT, BURST_WINDOW, NIGHT_END_HOUR } from '../hospital-web/oddPcRules.js';

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

// 라이선스 키 만료 30·7·1일 전 알림 (SFR-100 ④, SFR-168). 주기 작업이 부른다.
// 키마다 지금 단계(30·7·1)를 정하고, 그 단계에 들어선 뒤 이 키 알림이 없을 때만 1번 남긴다.
// 그래서 매시간 돌아도 단계마다 한 번씩만 쌓인다. 판정은 DB now() (규칙 6)
export async function notifyExpiringKeys(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `WITH k AS (
       SELECT id, expires_at,
              CASE WHEN expires_at - now() <= interval '1 day' THEN 1
                   WHEN expires_at - now() <= interval '7 days' THEN 7
                   ELSE 30 END AS stage
         FROM license_key
        WHERE revoked_at IS NULL AND expires_at > now()
          AND expires_at - now() <= interval '30 days'
     )
     SELECT k.id FROM k
      WHERE NOT EXISTS (
        SELECT 1 FROM admin_notification n
         WHERE n.kind = 'key_expiring' AND n.ref_id = k.id
           AND n.last_at >= k.expires_at - make_interval(days => k.stage))`,
  );
  for (const { id } of rows) await notifyAdmin(pool, 'key_expiring', id);
  return rows.length;
}

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // 최근 발생 순이라 '마지막 발생 시각|id' 를 커서로 쓴다 (횟수가 늘면 last_at 이 바뀌어 id 만으로는 순서를 못 이어 감)
  cursor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|\d+$/)
    .optional(),
});
const idParams = z.object({ id: z.coerce.number().int().positive() });

interface NotificationRow {
  id: string;
  kind: AdminNotificationKind;
  occurrences: number;
  last_at: Date;
  read: boolean;
  hospital_name: string | null;
  pc_name: string | null;
  pc_released: boolean | null;
  key_days_left: number | null;
  odd_night: boolean | null;
  odd_burst: boolean | null;
}

const FIXED_TEXT: Partial<Record<AdminNotificationKind, string>> = {
  collect_fail: '병상 수집 3회 연속 실패',
  signup: '새 가입 신청',
  odd_pc: '이상 PC 등록 감지',
  api_quota: '공공 데이터 호출 한도 임박',
  integrity: '정합성 점검 이상',
};

function notificationText(r: NotificationRow): string {
  if (r.kind === 'pc_change') {
    const what = r.pc_released ? '해제' : '등록';
    return `${r.hospital_name ?? ''} PC ${what}${r.pc_name ? ` · ${r.pc_name}` : ''}`;
  }
  if (r.kind === 'key_expiring') {
    return `${r.hospital_name ?? ''} 라이선스 키 ${r.key_days_left ?? 0}일 뒤 만료`;
  }
  // 'A병원 이상 PC 등록(새벽)' (SFR-148). 왜 수상한지 괄호에 적는다
  if (r.kind === 'odd_pc' && r.hospital_name) {
    const why = [r.odd_night && '새벽', r.odd_burst && '1시간 안 2대 이상'].filter(Boolean);
    return `${r.hospital_name} 이상 PC 등록${why.length ? `(${why.join('·')})` : ''}`;
  }
  return FIXED_TEXT[r.kind] ?? r.kind;
}

// GET /admin/notifications · POST /admin/notifications/{id}/read (A-02 모니터링)
export function adminNotificationRouter(pool: pg.Pool, adminOnly: RequestHandler): Router {
  const router = Router();

  router.get('/admin/notifications', adminOnly, async (req, res) => {
    const q = parseBody(listSchema, req.query);
    const [cursorAt, cursorId] = q.cursor ? q.cursor.split('|') : [null, null];
    const { rows } = await pool.query<NotificationRow>(
      `SELECT n.id, n.kind, n.occurrences, n.last_at, n.read_at IS NOT NULL AS read,
              COALESCE(h.name, kh.name) AS hospital_name,
              p.name AS pc_name, p.released AS pc_released,
              ceil(extract(epoch FROM lk.expires_at - n.last_at) / 86400)::int AS key_days_left,
              o.night AS odd_night, o.burst AS odd_burst
         FROM admin_notification n
         LEFT JOIN hospital h ON n.kind IN ('pc_change', 'odd_pc') AND h.id = n.ref_id
         -- 이상 PC 알림: 그 병원에서 알림 시각까지 마지막으로 등록된 PC 의 등록 시각으로 이유를 다시 본다 (oddPc.ts 와 같은 기준)
         LEFT JOIN LATERAL (
           SELECT extract(hour FROM pc.registered_at AT TIME ZONE 'Asia/Seoul') < $4 AS night,
                  (SELECT count(*) FROM hospital_pc x
                    WHERE x.hospital_id = pc.hospital_id
                      AND x.registered_at > pc.registered_at - $5::interval
                      AND x.registered_at <= pc.registered_at) >= $6 AS burst
             FROM hospital_pc pc
            WHERE n.kind = 'odd_pc' AND pc.hospital_id = n.ref_id AND pc.registered_at <= n.last_at
            ORDER BY pc.registered_at DESC
            LIMIT 1
         ) o ON true
         -- PC 알림: 그 병원에서 알림 시각까지 가장 마지막에 등록·해제된 PC (같은 시각이면 등록을 먼저 본다)
         LEFT JOIN LATERAL (
           SELECT pc.name, pc.released_at IS NOT NULL AND pc.released_at <= n.last_at AS released
             FROM hospital_pc pc
            WHERE n.kind = 'pc_change' AND pc.hospital_id = n.ref_id
              AND pc.registered_at <= n.last_at
            ORDER BY CASE WHEN pc.released_at <= n.last_at THEN pc.released_at
                          ELSE pc.registered_at END DESC,
                     (pc.released_at IS NULL OR pc.released_at > n.last_at) DESC
            LIMIT 1
         ) p ON true
         LEFT JOIN license_key lk ON n.kind = 'key_expiring' AND lk.id = n.ref_id
         LEFT JOIN hospital kh ON kh.id = lk.hospital_id
        -- 커서는 밀리초까지만 담기므로 비교·정렬도 밀리초로 맞춘다 (DB 는 마이크로초까지 저장)
        WHERE ($1::timestamptz IS NULL
               OR (date_trunc('milliseconds', n.last_at), n.id) < ($1, $2::bigint))
        ORDER BY date_trunc('milliseconds', n.last_at) DESC, n.id DESC
        LIMIT $3`,
      [cursorAt, cursorId, q.limit + 1, NIGHT_END_HOUR, BURST_WINDOW, BURST_COUNT],
    );
    const { rows: unread } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM admin_notification WHERE read_at IS NULL',
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({
      items: page.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        text: notificationText(r),
        occurrences: r.occurrences,
        lastAt: r.last_at.toISOString(),
        read: r.read,
      })),
      nextCursor: rows.length > q.limit ? `${last.last_at.toISOString()}|${last.id}` : null,
      unread: unread[0].n,
    });
  });

  // 알림을 열면 읽음. 같은 일이 다시 생기면 notifyAdmin 이 다시 '안 읽음'으로 돌린다
  router.post('/admin/notifications/:id/read', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const { rowCount } = await pool.query(
      'UPDATE admin_notification SET read_at = COALESCE(read_at, now()) WHERE id = $1',
      [id],
    );
    if (rowCount === 0) throw new AppError(404, 'NOT_FOUND', '알림을 찾을 수 없어요');
    res.status(204).end();
  });

  return router;
}
