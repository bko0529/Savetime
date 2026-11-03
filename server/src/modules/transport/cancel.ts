// 이송 취소 (부록 A24·A28·A29, 사건 CANCEL). 상태 변경은 반드시 stateMachine.ts의 전이 함수를 거친다 (절대 규칙 4).
// 이송 건과 병원 요청을 같은 트랜잭션에서 바꾼다. 부르는 쪽이 트랜잭션을 열고 client를 넘긴다.
// 실시간 알림(event_log·소켓)은 S3 실시간 모듈이 생기면 여기서 함께 남긴다.
import type pg from 'pg';
import {
  CASCADE,
  TARGET_STATES,
  transitionHreq,
  transitionTransport,
  type CancelReason,
  type HreqStatus,
  type TransportStatus,
} from '../../domain/stateMachine.js';

export interface CancelResult {
  transportId: string;
  from: TransportStatus;
  version: number;
  closedRequestIds: string[];
}

export async function cancelTransport(
  client: pg.PoolClient,
  transportId: string,
  reason: CancelReason,
  clientVersion?: number,
): Promise<CancelResult> {
  // 시간 판정은 서버 여러 대가 같은 시계를 보도록 DB 시각으로 한다 (SFR-160)
  const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
  const now = clock[0].now;

  // 같은 이송 건을 동시에 바꾸려는 요청(팀원 동시 취소, 병원 승인 등)을 한 줄로 세운다
  const { rows } = await client.query<{ status: TransportStatus; version: number }>(
    'SELECT status, version FROM transport WHERE id = $1 FOR UPDATE',
    [transportId],
  );
  const transport = rows[0];
  if (!transport) throw new Error(`이송 건이 없어요: ${transportId}`);

  // 표에 없는 전이(이미 끝난 건 등)와 버전 불일치는 여기서 TransitionError로 막힌다
  const { to, history } = transitionTransport(transport.status, 'CANCEL', {
    now,
    version: transport.version,
    clientVersion,
    cancelReason: reason,
  });

  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, cancelled_at = now(), cancel_reason = $3, version = version + 1
      WHERE id = $1
     RETURNING version`,
    [transportId, to, reason],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );

  // 연쇄: 열린 병원 요청과 확정 요청을 닫는다 (부록 A-2 41·45). 닫힌 요청은 병원 웹에서 환자 정보를 못 본다 (SER-014)
  // 앞 회차에 남은 요청도 함께 닫는다. 취소된 이송의 요청이 병원 웹에 열려 있으면 안 된다.
  const closedRequestIds: string[] = [];
  for (const { target, event } of CASCADE.CANCEL ?? []) {
    const states = TARGET_STATES[target as keyof typeof TARGET_STATES];
    const { rows: requests } = await client.query<{
      id: string;
      status: HreqStatus;
      version: number;
    }>(
      `SELECT hr.id, hr.status, hr.version
         FROM hospital_request hr
         JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $1 AND hr.status = ANY($2::hreq_status[])
        ORDER BY hr.id
        FOR UPDATE OF hr`,
      [transportId, states],
    );
    for (const request of requests) {
      const result = transitionHreq(request.status, event, { now, version: request.version });
      await client.query(
        `UPDATE hospital_request
            SET status = $2, closed_reason = $3, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [request.id, result.to, result.closeReason],
      );
      closedRequestIds.push(request.id);
    }
  }

  return { transportId, from: transport.status, version: updated[0].version, closedRequestIds };
}
