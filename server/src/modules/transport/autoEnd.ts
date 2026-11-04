// 활동 없음 자동 종료 (SFR-086, 부록 A28): 진행 중 이송 건에 마지막 활동(입력·병원 응답·상태 변경, 위치 기록 제외) 후
// 2시간 동안 변화가 없으면 '취소'(사유 auto_inactive)로 끝낸다.
// 건마다 타이머를 다시 거는 대신 1분마다 한 번 DB를 훑는다. 재시작해도 놓치지 않고, 서버가 2대여도 BullMQ가 한 번만 돌린다.
// 판정은 DB now()로 한다 (절대 규칙 6). 최대 1분 늦게 끝날 수 있다.
import type pg from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/transaction.js';
import { ACTIVE, TransitionError } from '../../domain/stateMachine.js';
import type { LoggedEvent } from '../realtime/eventLog.js';
import { cancelTransport } from './cancel.js';

export const AUTO_END_EVERY_MS = 60_000;
export const INACTIVE_LIMIT = '2 hours';

// 끝낸 이송 건의 이벤트를 모아 돌려준다. 부르는 쪽이 (커밋된 뒤) 실시간으로 보낸다
export async function endInactiveTransports(
  pool: pg.Pool,
  logger: Logger,
  limit = INACTIVE_LIMIT,
): Promise<LoggedEvent[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM transport
      WHERE status = ANY($1::transport_status[]) AND last_activity_at <= now() - $2::interval
      ORDER BY last_activity_at`,
    [ACTIVE, limit],
  );
  const events: LoggedEvent[] = [];
  for (const { id } of rows) {
    try {
      const result = await withTransaction(pool, async (client) => {
        // 잠근 뒤 다시 본다: 훑은 뒤 그사이 활동이 생겼거나 다른 이유로 끝났으면 그대로 둔다
        const { rows: still } = await client.query(
          `SELECT 1 FROM transport
            WHERE id = $1 AND status = ANY($2::transport_status[])
              AND last_activity_at <= now() - $3::interval
            FOR UPDATE`,
          [id, ACTIVE, limit],
        );
        if (!still[0]) return null;
        return cancelTransport(client, id, 'auto_inactive');
      });
      if (result) events.push(...result.events);
    } catch (err) {
      // 한 건이 실패해도 나머지는 계속 끝낸다. 상태 전이표가 막은 건은 다음 바퀴에 다시 보지 않아도 된다
      if (!(err instanceof TransitionError)) {
        logger.error({ message: (err as Error).message, transportId: id }, '자동 종료 실패');
      }
    }
  }
  return events;
}
