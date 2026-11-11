// 개인정보 자동 파기 (DAR-003·010·012·014, D-109). 주기 작업(1시간마다)이 부른다.
// 기간 판정은 모두 DB now() (규칙 6). 서버가 2대여도 BullMQ 가 한 번만 돌린다 (규칙 7).
// 로그에는 건수만 남긴다. 누구의 무엇을 지웠는지는 남기지 않는다 (SER-012)
//
// - DAR-010 환자 평가: 보낸 지 30일 지나면 항목을 비우고 purged_at 을 찍는다. 행은 남겨 응답·시간 통계가 깨지지 않게 한다
// - DAR-012 공무원증 사진: 30일 동안 처리되지 않은 신청은 사진을 지우고 '반려(사진 만료)'로 바꾼 뒤 다시 신청하라고 알린다
// - DAR-003 반려된 가입 신청: 반려일부터 30일 지나도 다시 신청하지 않았으면 신청 기록을 지우고, 승인된 적 없는 계정의
//   개인 정보를 탈퇴와 같은 방식으로 비운다 (계정 행은 남는 기록이 가리킬 수 있어 지우지 않고 '탈퇴' 상태로)
// - DAR-014 익명 이송 경로: 이송이 끝난 지 3년 지나면 지운다
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/transaction.js';
import type { PhotoStore } from '../auth/photoStore.js';
import { endSessions, forgetSessionState } from '../auth/session.js';
import { appendEvents, type LoggedEvent } from '../realtime/eventLog.js';

export const RETENTION_EVERY_MS = 60 * 60 * 1000;
export const ASSESSMENT_KEEP = '30 days';
export const PENDING_PHOTO_KEEP = '30 days';
export const REJECTED_SIGNUP_KEEP = '30 days';
export const ROUTE_KEEP = '3 years';

// 환자 평가 항목 (보낸 대원 칸은 원래 없다, DAR-013). 이송 건·회차·보낸 시각만 남는다.
// assessment 에 칸이 늘면 여기에도 넣어야 한다 — 빠뜨리면 retention.test.ts 가 실패해 알려 준다
export const ASSESSMENT_KEEP_COLUMNS = [
  'id',
  'transport_id',
  'seq',
  'sent_at',
  'purged_at',
  'unknown_fields',
];
export const ASSESSMENT_FIELDS = [
  'chief_complaint',
  'sex',
  'age_band',
  'consciousness',
  'bp',
  'pulse',
  'resp',
  'spo2',
  'pain_site',
  'pain_score',
  'onset',
  'trauma',
  'trauma_cause',
  'history',
  'temp',
  'glucose',
  'ktas',
];

// DAR-010
export async function purgeAssessments(db: Pick<pg.Pool, 'query'>): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE assessment
        SET ${ASSESSMENT_FIELDS.map((f) => `${f} = NULL`).join(', ')},
            unknown_fields = '{}', purged_at = now()
      WHERE purged_at IS NULL AND sent_at <= now() - $1::interval`,
    [ASSESSMENT_KEEP],
  );
  return rowCount ?? 0;
}

// DAR-012. 결과 이벤트(푸시 포함)는 커밋 뒤 부르는 쪽이 보낸다. 사진 파일도 커밋 뒤에 지운다
// (먼저 지웠다가 롤백되면 '대기'인데 사진만 없는 신청이 생긴다 — 가입 승인과 같은 순서)
export async function expirePendingPhotos(
  pool: pg.Pool,
  redis: Redis,
  photos: PhotoStore | undefined,
): Promise<{ count: number; events: LoggedEvent[] }> {
  const { rows: due } = await pool.query<{ id: string }>(
    `SELECT s.id FROM signup_request s JOIN paramedic p ON p.id = s.paramedic_id
      WHERE s.result IS NULL AND p.status = 'pending' AND s.created_at <= now() - $1::interval`,
    [PENDING_PHOTO_KEEP],
  );
  const events: LoggedEvent[] = [];
  let count = 0;
  for (const { id } of due) {
    const done = await withTransaction(pool, async (client) => {
      // 잠근 뒤 다시 본다: 그사이 관리자가 승인·반려했으면 건드리지 않는다
      const { rows } = await client.query<{ paramedic_id: string; photo_key: string | null }>(
        `SELECT s.paramedic_id, s.photo_key FROM signup_request s JOIN paramedic p ON p.id = s.paramedic_id
          WHERE s.id = $1 AND s.result IS NULL AND p.status = 'pending'
          FOR UPDATE OF s, p`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE signup_request
            SET result = 'rejected', reject_reason = 'photo_expired', decided_at = now(), photo_key = NULL
          WHERE id = $1`,
        [id],
      );
      await client.query("UPDATE paramedic SET status = 'rejected' WHERE id = $1", [
        row.paramedic_id,
      ]);
      // 신청자에게 '반려(사진 만료) · 다시 신청해 주세요' (앱이 안 보이면 푸시, dispatch.ts)
      const logged = await appendEvents(client, [
        {
          room: `paramedic:${row.paramedic_id}`,
          name: 'account.signup_result',
          entityType: 'signup_request',
          entityId: id,
          payload: { result: 'rejected', reason: 'photo_expired' },
        },
      ]);
      return { paramedicId: row.paramedic_id, photoKey: row.photo_key, logged };
    });
    if (!done) continue;
    count += 1;
    events.push(...done.logged);
    await forgetSessionState({ redis }, done.paramedicId);
    // 지우기에 실패해도 DB 에는 키가 이미 없어 누구 사진인지 이어지지 않는다 (키에 대원 정보 없음)
    if (done.photoKey && photos) await photos.remove(done.photoKey).catch(() => {});
  }
  return { count, events };
}

// DAR-003
export async function purgeRejectedSignups(pool: pg.Pool, redis: Redis): Promise<number> {
  // 마지막 신청이 반려된 지 30일 넘었고 그 뒤로 다시 신청하지 않은 계정 (승인된 적 없는 계정만 'rejected' 상태다)
  const { rows: due } = await pool.query<{ id: string }>(
    `SELECT p.id FROM paramedic p
      WHERE p.status = 'rejected'
        AND (SELECT s.decided_at FROM signup_request s
              WHERE s.paramedic_id = p.id ORDER BY s.created_at DESC LIMIT 1) <= now() - $1::interval`,
    [REJECTED_SIGNUP_KEEP],
  );
  let count = 0;
  for (const { id } of due) {
    const done = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM paramedic WHERE id = $1 FOR UPDATE',
        [id],
      );
      // 잠근 사이 다시 신청했으면(pending) 건드리지 않는다
      if (rows[0]?.status !== 'rejected') return false;
      await client.query('DELETE FROM signup_request WHERE paramedic_id = $1', [id]);
      await client.query('DELETE FROM push_device WHERE paramedic_id = $1', [id]);
      // 탈퇴(withdraw.ts)와 같은 방식: 사람을 알아볼 값을 모두 비우고 옛 아이디로 로그인되지 않게 한다
      await client.query(
        `UPDATE paramedic
            SET status = 'withdrawn', withdrawn_at = now(),
                login_id = 'withdrawn:' || id, password_hash = '',
                name = '삭제된 가입 신청', rank = '', safety_center = '', employee_no = '',
                failed_count = 0, locked_until = NULL
          WHERE id = $1`,
        [id],
      );
      await endSessions({ redis }, client, id);
      return true;
    });
    if (!done) continue;
    count += 1;
    await forgetSessionState({ redis }, id);
  }
  return count;
}

// DAR-014
export async function purgeAnonymousRoutes(db: Pick<pg.Pool, 'query'>): Promise<number> {
  const { rowCount } = await db.query(
    'DELETE FROM anonymous_route WHERE ended_at <= now() - $1::interval',
    [ROUTE_KEEP],
  );
  return rowCount ?? 0;
}

export interface RetentionDeps {
  pool: pg.Pool;
  redis: Redis;
  photos?: PhotoStore;
  logger: Logger;
}

// 주기 작업 한 번: 네 가지를 차례로. 하나가 실패해도 나머지는 돈다 (다음 회차에 다시 시도)
export async function runRetention(deps: RetentionDeps): Promise<LoggedEvent[]> {
  const { pool, redis, photos, logger } = deps;
  const counts: Record<string, number> = {};
  let events: LoggedEvent[] = [];
  const step = async (name: string, work: () => Promise<number>) => {
    try {
      counts[name] = await work();
    } catch (err) {
      logger.error({ step: name, message: (err as Error).message }, '개인정보 파기 실패');
    }
  };
  await step('assessments', () => purgeAssessments(pool));
  await step('pendingPhotos', async () => {
    const r = await expirePendingPhotos(pool, redis, photos);
    events = r.events;
    return r.count;
  });
  await step('rejectedSignups', () => purgeRejectedSignups(pool, redis));
  await step('anonymousRoutes', () => purgeAnonymousRoutes(pool));
  if (Object.values(counts).some((n) => n > 0)) logger.info(counts, '개인정보 파기');
  return events;
}
