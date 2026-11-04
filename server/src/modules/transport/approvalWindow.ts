// 승인 유효시간 5분 (SFR-127, 부록 A9 · A-2 43, 실시간 설계 6장 '해제 경보'·'승인 해제')
// - 4분: 아직 고르지 않은 유효 승인이 1곳 이상이면 팀에 approval.expiring ("1분 뒤 승인이 해제돼요")
// - 5분: 이송 건에 APPROVAL_WINDOW_ENDED → 연쇄로 승인 요청을 APPROVAL_TIMEOUT(닫힘, expired_approval)
//        요청 중이면 예비 추천(approval_window)으로, 전화 확인 중이면 전화 화면 그대로 (A9)
// 시간 판정은 DB now() 하나로 한다 (절대 규칙 6). 타이머가 늦거나 두 번 실행돼도 결과는 같다.
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import {
  transitionHreq,
  transitionTransport,
  type HreqStatus,
  type TransportStatus,
} from '../../domain/stateMachine.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';

// 해제 경보는 승인 해제 1분 전
export const EXPIRING_LEAD_MS = 60_000;

interface RoundRow {
  transport_id: string;
  round_no: number;
  respond_until: Date;
  approval_valid_until: Date;
  due: boolean;
  is_current: boolean;
}

async function loadRound(
  client: pg.PoolClient,
  roundId: string,
  leadMs: number,
): Promise<RoundRow | undefined> {
  const { rows } = await client.query<RoundRow>(
    `SELECT r.transport_id, r.round_no, r.respond_until, r.approval_valid_until,
            now() >= r.approval_valid_until - make_interval(secs => $2) AS due,
            r.round_no = (SELECT max(round_no) FROM request_round WHERE transport_id = r.transport_id) AS is_current
       FROM request_round r WHERE r.id = $1`,
    [roundId, leadMs / 1000],
  );
  return rows[0];
}

// 4분 해제 경보. null: 회차 없음 · 'not_due': 아직 4분 전 · 배열: 보낼 이벤트 (조건이 안 맞으면 빈 배열)
// 상태를 바꾸지 않으니 잠그지 않고 읽기만 한다
export async function warnApprovalExpiring(
  pool: pg.Pool,
  roundId: string,
): Promise<LoggedEvent[] | 'not_due' | null> {
  return withTransaction(pool, async (client) => {
    const round = await loadRound(client, roundId, EXPIRING_LEAD_MS);
    if (!round) return null;
    if (!round.due) return 'not_due';
    // 확정·새 회차·취소·예비 전환이면 경보를 보내지 않는다 (실시간 설계 6장 '취소되는 경우')
    if (!round.is_current) return [];
    const { rows } = await client.query<{ status: TransportStatus; team_id: string | null; version: number; n: number }>(
      `SELECT t.status, t.team_id, t.version,
              (SELECT count(*)::int FROM hospital_request hr
                WHERE hr.round_id = $2 AND hr.status = 'approved' AND now() < $3) AS n
         FROM transport t WHERE t.id = $1`,
      [round.transport_id, roundId, round.approval_valid_until],
    );
    const t = rows[0];
    if (!t || (t.status !== 'requesting' && t.status !== 'phone_check') || t.n === 0) return [];
    return appendEvents(client, [
      {
        room: `team:${t.team_id}`,
        name: 'approval.expiring',
        entityType: 'transport',
        entityId: round.transport_id,
        entityVersion: t.version,
        // ID·시각만 (절대 규칙 5)
        payload: {
          transportId: round.transport_id,
          releaseAt: round.approval_valid_until.toISOString(),
        },
      },
    ]);
  });
}

// 5분 승인 해제. null: 회차 없음 · 'not_due': 아직 5분 전 · 배열: 커밋 뒤 보낼 이벤트 (바뀐 게 없으면 빈 배열)
export async function endApprovalWindow(
  pool: pg.Pool,
  roundId: string,
): Promise<LoggedEvent[] | 'not_due' | null> {
  return withTransaction(pool, async (client) => {
    const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
    const now = clock[0].now;
    const round = await loadRound(client, roundId, 0);
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

    // 지난 회차거나, 이미 확정·예비 추천·취소된 이송 건이면 할 일이 없다.
    // (확정되면 나머지 승인은 OTHER_CONFIRMED로, 취소·예비 전환이면 다른 사건으로 이미 닫혔다)
    const windowOpen =
      round.is_current && (transport.status === 'requesting' || transport.status === 'phone_check');
    if (!windowOpen) return [];

    const room = `team:${transport.team_id}`;
    const events: EventRecord[] = [];

    // ① 이송 건 사건을 먼저 판정한다 (정방향 연쇄, stateMachine.ts의 CASCADE.APPROVAL_WINDOW_ENDED)
    //    요청 중 → 예비 추천(approval_window), 전화 확인 중 → 그대로
    const { to, history } = transitionTransport(transport.status, 'APPROVAL_WINDOW_ENDED', {
      now,
      version: transport.version,
    });

    // ② 연쇄: 승인 요청 → 닫힘(expired_approval). 2분 타이머가 늦어 대기가 남았으면 그것도 만료시킨다
    //    (5분이면 2분도 이미 지났다. 예비 추천으로 가는데 열린 요청이 남으면 안 된다)
    for (const request of requests) {
      let event: 'APPROVAL_TIMEOUT' | 'RESPOND_TIMEOUT';
      if (request.status === 'approved') event = 'APPROVAL_TIMEOUT';
      else if (request.status === 'waiting') event = 'RESPOND_TIMEOUT';
      else continue;
      const result = transitionHreq(request.status, event, {
        now,
        version: request.version,
        respondUntil: round.respond_until,
        approvalValidUntil: round.approval_valid_until,
      });
      const { rows: updated } = await client.query<{ version: number }>(
        `UPDATE hospital_request SET status = $2, closed_reason = $3, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [request.id, result.to, result.closeReason],
      );
      // 병원 웹: '요청 종료' 표시, 상세 화면 닫기 (SFR-127). 환자 정보 없음 (절대 규칙 5)
      events.push({
        room: `hospital:${request.hospital_id}`,
        name: 'request.changed',
        entityType: 'hospital_request',
        entityId: request.id,
        entityVersion: updated[0].version,
        payload: {
          requestId: Number(request.id),
          status: result.to,
          closeReason: result.closeReason,
          byName: null,
          pcName: null,
        },
      });
    }

    let transportVersion = transport.version;
    if (to !== transport.status) {
      const { rows } = await client.query<{ version: number }>(
        `UPDATE transport
            SET status = $2, version = version + 1, last_activity_at = now(), fallback_reason = $3
          WHERE id = $1 RETURNING version`,
        [round.transport_id, to, history.reason],
      );
      await client.query(
        `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [round.transport_id, history.from, history.to, history.event, history.reason, history.at],
      );
      transportVersion = rows[0].version;
    }

    // 승인이 하나도 없었고 상태도 그대로면(전화 확인 중, 이미 다 닫힘) 알릴 게 없다
    if (events.length === 0 && to === transport.status) return [];

    // 팀: 승인 목록 비활성 (SFR-127)
    events.push({
      room,
      name: 'approval.expired',
      entityType: 'transport',
      entityId: round.transport_id,
      entityVersion: transportVersion,
      payload: { transportId: round.transport_id },
    });
    if (to !== transport.status) {
      events.push({
        room,
        name: 'transport.status',
        entityType: 'transport',
        entityId: round.transport_id,
        entityVersion: transportVersion,
        payload: {
          transportId: round.transport_id,
          status: to,
          event: history.event,
          reason: history.reason,
          byName: null,
        },
      });
    }
    return appendEvents(client, events);
  });
}
