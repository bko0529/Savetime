// 직전 환자 정보 채워두기 (SFR-157) · 종료 10분 뒤 팀 연결 끊기 (DAR-013) · 직전 건 제외 병원 이어받기 (SFR-086·157).
// - 직전 환자 정보를 따로 복사해 두지 않는다. 팀 작성 중 정보(team_draft)는 이송 중 그 환자 정보를 그대로 들고 있으니,
//   이송이 끝난 뒤 10분 동안 그걸 '직전 환자 정보'라고 표시만 하고, 10분이 지나면 비운다 (요구사항: 별도로 보관하지 않음)
// - '끝난 뒤 아무도 안 고친' 작성 중 정보만 직전 환자 정보로 본다. 끝난 뒤 고쳤으면 다음 환자를 입력하는 중이라 건드리지 않는다
// - 10분 판정은 DB now() (절대 규칙 6). 정리는 1분마다 훑는 주기 작업이 한다(2시간 자동 종료와 같은 방식)
import type pg from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/transaction.js';
import { ACTIVE } from '../../domain/stateMachine.js';
import { appendEvents, type LoggedEvent } from '../realtime/eventLog.js';

export const PREV_PATIENT_MINUTES = 10;
export const PREV_PATIENT_SWEEP_EVERY_MS = 60_000;

type Db = pg.Pool | pg.PoolClient;

// 이송 건이 끝난 시각 (도착 또는 취소)
const ENDED_AT = 'coalesce(t.arrived_at, t.cancelled_at)';

export interface PrevPatientState {
  // 작성 중 정보가 직전 이송의 환자 정보 그대로(끝난 뒤 아무도 안 고침)이고 진행 중 이송이 없음
  transportId: string;
  expiresAt: Date;
  // 10분이 지났는데 아직 안 비워짐(주기 작업이 1분 안에 비운다). 화면에는 빈 입력으로 보여야 한다
  expired: boolean;
}

// 팀의 작성 중 정보가 '직전 환자 정보'인지. 아니면 null.
// 팀의 가장 최근에 끝난 이송 건을 보고: 작성 중 정보가 있고, 그 건이 끝난 뒤 아무도 안 고쳤고, 진행 중 이송이 없어야 한다
export async function prevPatientState(db: Db, teamId: string): Promise<PrevPatientState | null> {
  const { rows } = await db.query<{
    id: string;
    expires_at: Date;
    expired: boolean;
    untouched: boolean | null;
    active: boolean;
  }>(
    `SELECT t.id, ${ENDED_AT} + make_interval(mins => $2) AS expires_at,
            ${ENDED_AT} + make_interval(mins => $2) <= now() AS expired,
            (SELECT d.updated_at <= ${ENDED_AT} FROM team_draft d WHERE d.team_id = $1) AS untouched,
            EXISTS (SELECT 1 FROM transport a
                     WHERE a.team_id = $1 AND a.status = ANY($3::transport_status[])) AS active
       FROM transport t
      WHERE t.team_id = $1 AND t.status IN ('arrived', 'cancelled')
      ORDER BY ${ENDED_AT} DESC
      LIMIT 1`,
    [teamId, PREV_PATIENT_MINUTES, ACTIVE],
  );
  const row = rows[0];
  // untouched 가 null 이면 작성 중 정보가 없다 (이미 지웠거나 쓴 적 없음)
  if (!row || row.active || row.untouched !== true) return null;
  return { transportId: row.id, expiresAt: row.expires_at, expired: row.expired };
}

// 10분 지난 직전 환자 정보를 비운다. 팀 작성 중 정보 행이 잠긴 트랜잭션 안에서 부른다.
// 비웠으면 팀원 화면을 비우라는 이벤트 기록을 돌려준다
export async function clearExpiredPrevPatient(client: pg.PoolClient, teamId: string) {
  const state = await prevPatientState(client, teamId);
  if (!state?.expired) return null;
  await client.query('DELETE FROM team_draft WHERE team_id = $1', [teamId]);
  return {
    room: `team:${teamId}`,
    name: 'draft.updated',
    entityType: 'team_draft',
    entityId: teamId,
    // 사람이 지운 게 아니라 10분이 지나 비웠다 (byName null)
    payload: { version: 0, fields: [], byName: null, overwritten: [], reason: 'prev_expired' },
  };
}

// 주기 작업: 끝난 지 10분 지난 이송 건의 팀 연결을 끊고(DAR-013), 그 팀의 직전 환자 정보를 비운다 (SFR-157)
export async function releaseEndedTransports(
  pool: pg.Pool,
  logger: Logger,
): Promise<LoggedEvent[]> {
  const { rows } = await pool.query<{ id: string; team_id: string }>(
    `SELECT t.id, t.team_id FROM transport t
      WHERE t.team_id IS NOT NULL AND t.status IN ('arrived', 'cancelled')
        AND ${ENDED_AT} <= now() - make_interval(mins => $1)
      ORDER BY ${ENDED_AT}`,
    [PREV_PATIENT_MINUTES],
  );
  const events: LoggedEvent[] = [];
  for (const row of rows) {
    try {
      const logged = await withTransaction(pool, async (client) => {
        // 잠금 순서: 이송 건 → 팀 작성 중 정보 (다른 곳도 이송 건을 먼저 잠근다)
        const { rows: still } = await client.query(
          `SELECT 1 FROM transport t
            WHERE t.id = $1 AND t.team_id IS NOT NULL AND ${ENDED_AT} <= now() - make_interval(mins => $2)
            FOR UPDATE`,
          [row.id, PREV_PATIENT_MINUTES],
        );
        if (!still[0]) return [];
        await client.query('SELECT 1 FROM team_draft WHERE team_id = $1 FOR UPDATE', [row.team_id]);
        // 팀 연결을 끊기 전에 비운다 (끊고 나면 어느 팀의 직전 환자인지 알 수 없다)
        const cleared = await clearExpiredPrevPatient(client, row.team_id);
        // 이송 건 기록은 남기고 팀 연결만 끊는다. version 은 그대로: 상태가 바뀐 게 아니다
        await client.query('UPDATE transport SET team_id = NULL WHERE id = $1', [row.id]);
        return cleared ? appendEvents(client, [cleared]) : [];
      });
      events.push(...logged);
    } catch (err) {
      logger.error({ message: (err as Error).message, transportId: row.id }, '종료 10분 정리 실패');
    }
  }
  return events;
}

// 직전 이송 건에서 이어받을 제외 병원 (SFR-086: 10분 안에 이어진 직전 이송 건의 수용 불가 병원).
// 같은 팀이고 끝난 지 10분 안인 건만. 아니면 이어받지 않는다(빈 목록, 오류 아님)
export async function inheritedExclusions(
  db: Db,
  teamId: string,
  prevTransportId: string | null | undefined,
): Promise<{ prevId: string; hospitalIds: string[] } | null> {
  if (!prevTransportId) return null;
  const { rows } = await db.query<{ hospital_ids: string[] | null }>(
    `SELECT array_agg(DISTINCT hr.hospital_id::text) FILTER (WHERE hr.status = 'unacceptable') AS hospital_ids
       FROM transport t
       LEFT JOIN request_round r ON r.transport_id = t.id
       LEFT JOIN hospital_request hr ON hr.round_id = r.id
      WHERE t.id = $1 AND t.team_id = $2 AND t.status IN ('arrived', 'cancelled')
        AND ${ENDED_AT} > now() - make_interval(mins => $3)
      GROUP BY t.id`,
    [prevTransportId, teamId, PREV_PATIENT_MINUTES],
  );
  if (!rows[0]) return null;
  return { prevId: prevTransportId, hospitalIds: rows[0].hospital_ids ?? [] };
}
