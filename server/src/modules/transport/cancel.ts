// 이송 취소 (부록 A24·A28·A29, 사건 CANCEL). 상태 변경은 반드시 stateMachine.ts의 전이 함수를 거친다 (절대 규칙 4).
// 이송 건과 병원 요청을 같은 트랜잭션에서 바꾸고, 커밋 뒤 보낼 실시간 이벤트도 같은 트랜잭션에서 기록한다.
// 부르는 쪽이 트랜잭션을 열고 client를 넘긴다. 돌려받은 events는 커밋한 뒤에 Realtime.publish로 보낸다.
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
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import { closeRoute } from './route.js';

export interface CancelResult {
  transportId: string;
  from: TransportStatus;
  version: number;
  closedRequestIds: string[];
  events: LoggedEvent[];
}

export async function cancelTransport(
  client: pg.PoolClient,
  transportId: string,
  reason: CancelReason,
  clientVersion?: number,
  // 팀원 화면 '김도윤 님이 이송을 취소했어요'. 시스템 취소(근무 종료 등)는 null
  byName: string | null = null,
): Promise<CancelResult> {
  // 시간 판정은 서버 여러 대가 같은 시계를 보도록 DB 시각으로 한다 (SFR-160)
  const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
  const now = clock[0].now;

  // 같은 이송 건을 동시에 바꾸려는 요청(팀원 동시 취소, 병원 승인 등)을 한 줄로 세운다
  const { rows } = await client.query<{
    status: TransportStatus;
    version: number;
    team_id: string | null;
  }>('SELECT status, version, team_id FROM transport WHERE id = $1 FOR UPDATE', [transportId]);
  const transport = rows[0];
  if (!transport) throw new Error(`이송 건이 없어요: ${transportId}`);

  // 표에 없는 전이(이미 끝난 건 등)와 버전 불일치는 여기서 TransitionError로 막힌다
  const { to, history } = transitionTransport(transport.status, 'CANCEL', {
    now,
    version: transport.version,
    clientVersion,
    cancelReason: reason,
  });

  // 이송이 끝나면 원본 출발 좌표를 지운다 (SER-002, schema.sql '이송 끝나면 NULL')
  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, cancelled_at = now(), cancel_reason = $3, version = version + 1,
            origin_lat = NULL, origin_lng = NULL
      WHERE id = $1
     RETURNING version`,
    [transportId, to, reason],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );

  // 위치 기록이 있으면 익명 경로(취소 표시)로 옮기고 원본을 지운다 (SER-002, SFR-041)
  await closeRoute(client, transportId, { cancelled: true });

  // 연쇄: 열린 병원 요청과 확정 요청을 닫는다 (부록 A-2 41·45). 닫힌 요청은 병원 웹에서 환자 정보를 못 본다 (SER-014)
  // 앞 회차에 남은 요청도 함께 닫는다. 취소된 이송의 요청이 병원 웹에 열려 있으면 안 된다.
  const closedRequestIds: string[] = [];
  const events: EventRecord[] = [];
  for (const { target, event } of CASCADE.CANCEL ?? []) {
    const states = TARGET_STATES[target as keyof typeof TARGET_STATES];
    const { rows: requests } = await client.query<{
      id: string;
      hospital_id: string;
      status: HreqStatus;
      version: number;
    }>(
      `SELECT hr.id, hr.hospital_id, hr.status, hr.version
         FROM hospital_request hr
         JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $1 AND hr.status = ANY($2::hreq_status[])
        ORDER BY hr.id
        FOR UPDATE OF hr`,
      [transportId, states],
    );
    for (const request of requests) {
      const result = transitionHreq(request.status, event, { now, version: request.version });
      const { rows: closed } = await client.query<{ version: number }>(
        `UPDATE hospital_request
            SET status = $2, closed_reason = $3, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [request.id, result.to, result.closeReason],
      );
      closedRequestIds.push(request.id);
      // 병원 웹: 그 행이 '이송 취소'로 바뀌고 응답 버튼이 꺼진다 (SFR-076)
      events.push({
        room: `hospital:${request.hospital_id}`,
        name: 'request.changed',
        entityType: 'hospital_request',
        entityId: request.id,
        entityVersion: closed[0].version,
        payload: {
          requestId: Number(request.id),
          status: result.to,
          closeReason: result.closeReason,
          byName: null,
          pcName: null,
        },
      });
      // 확정 병원은 도착 예정 목록에서도 빠진다 (SFR-121)
      if (request.status === 'confirmed') {
        events.push({
          room: `hospital:${request.hospital_id}`,
          name: 'incoming.removed',
          entityType: 'hospital_request',
          entityId: request.id,
          payload: { requestId: Number(request.id), reason: 'cancelled' },
        });
      }
    }
  }

  if (transport.team_id) {
    events.push({
      room: `team:${transport.team_id}`,
      name: 'transport.status',
      entityType: 'transport',
      entityId: transportId,
      entityVersion: updated[0].version,
      payload: {
        transportId,
        status: to,
        event: history.event,
        reason: history.reason,
        byName,
      },
    });
  }

  return {
    transportId,
    from: transport.status,
    version: updated[0].version,
    closedRequestIds,
    events: await appendEvents(client, events),
  };
}
