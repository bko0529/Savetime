// 응답 제한 2분 (SFR-124·112, 부록 A-2 39, A8): 회차의 respond_until이 지나면 아직 응답하지 않은 병원 요청을
// '만료'로 바꾸고, 대기·유효 승인이 하나도 남지 않으면 이송 건을 예비 추천(expired_no_approval)으로 바꾼다.
// 승인한 병원이 있으면 요청 중을 유지한다 (5분 승인 유효시간은 SFR-127, S4).
// 시간 판정은 DB now() 하나로 한다 (절대 규칙 6). 타이머가 늦거나 두 번 실행돼도 결과는 같다.
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import {
  transitionHreq,
  type HreqStatus,
  type TransportStatus,
} from '../../domain/stateMachine.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import { applyReverseCascade, roundCounts } from './hreqCascade.js';

// null: 회차가 없음 · 'not_due': 아직 2분 전 (타이머가 일찍 깨어남) · 배열: 커밋 뒤 보낼 이벤트 (아무것도 안 바뀌면 빈 배열)
export async function expireRound(
  pool: pg.Pool,
  roundId: string,
): Promise<LoggedEvent[] | 'not_due' | null> {
  return withTransaction(pool, async (client) => {
    const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
    const now = clock[0].now;
    const { rows: rounds } = await client.query<{
      transport_id: string;
      round_no: number;
      respond_until: Date;
      approval_valid_until: Date;
      due: boolean;
      is_current: boolean;
    }>(
      `SELECT r.transport_id, r.round_no, r.respond_until, r.approval_valid_until,
              now() >= r.respond_until AS due,
              r.round_no = (SELECT max(round_no) FROM request_round WHERE transport_id = r.transport_id) AS is_current
         FROM request_round r WHERE r.id = $1`,
      [roundId],
    );
    const round = rounds[0];
    if (!round) return null;
    if (!round.due) return 'not_due';

    // 잠금 순서: 이송 건 먼저, 그다음 병원 요청 id 오름차순 (stateMachine.ts 규칙 5)
    const { rows: transports } = await client.query<{
      status: TransportStatus;
      version: number;
      team_id: string | null;
    }>('SELECT status, version, team_id FROM transport WHERE id = $1 FOR UPDATE', [
      round.transport_id,
    ]);
    const transport = transports[0];
    const { rows: requests } = await client.query<{
      id: string;
      hospital_id: string;
      status: HreqStatus;
      version: number;
    }>(
      `SELECT id, hospital_id, status, version FROM hospital_request
        WHERE round_id = $1 ORDER BY id FOR UPDATE`,
      [roundId],
    );

    const events: EventRecord[] = [];
    for (const request of requests) {
      // 이미 응답했거나 닫힌 요청(승인·거절·전달 실패·취소 등)은 그대로 둔다
      if (request.status !== 'waiting') continue;
      const result = transitionHreq(request.status, 'RESPOND_TIMEOUT', {
        now,
        version: request.version,
        respondUntil: round.respond_until,
      });
      const { rows: updated } = await client.query<{ version: number }>(
        `UPDATE hospital_request SET status = $2, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [request.id, result.to],
      );
      request.status = result.to;
      // 병원 웹: 그 행을 다시 받아 승인·거절 버튼을 끈다 (SFR-124). 환자 정보는 넣지 않는다
      events.push({
        room: `hospital:${request.hospital_id}`,
        name: 'request.changed',
        entityType: 'hospital_request',
        entityId: request.id,
        entityVersion: updated[0].version,
        payload: {
          requestId: Number(request.id),
          status: result.to,
          closeReason: null,
          byName: null,
          pcName: null,
        },
      });
    }
    // 만료시킬 요청이 없으면(두 번째 실행, 이미 끝난 이송 건) 아무것도 알리지 않는다
    if (events.length === 0) return [];

    const room = `team:${transport.team_id}`;
    const counts = roundCounts(requests, round.approval_valid_until, now);
    events.push({
      room,
      name: 'request.expired',
      entityType: 'transport',
      entityId: round.transport_id,
      entityVersion: transport.version,
      payload: {
        transportId: round.transport_id,
        roundNo: round.round_no,
        anyApproved: counts.validApproved > 0,
      },
    });

    // 역방향 연쇄는 지금 회차일 때만. 지난 회차의 만료가 새 회차 진행 중인 이송 건을 바꾸면 안 된다
    if (round.is_current) {
      const changed = await applyReverseCascade(client, {
        transportId: round.transport_id,
        transport,
        room,
        now,
        changed: { event: 'RESPOND_TIMEOUT', fromStatus: 'waiting' },
        counts,
      });
      if (changed) events.push(changed);
    }
    return appendEvents(client, events);
  });
}
