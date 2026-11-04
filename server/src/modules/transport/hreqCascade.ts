// 역방향 연쇄: 병원 요청이 바뀐 뒤(전달 실패·2분 만료·거절·승인 취소) 이송 건 상태를 바꿀지 판정하고 반영한다.
// 판정 규칙은 stateMachine.ts의 transportEventAfterHreqChange 하나만 쓴다 (절대 규칙 4).
// 부르는 쪽이 같은 트랜잭션에서 이송 건 → 병원 요청 순서로 잠근 뒤 부른다 (stateMachine.ts 규칙 5).
import type pg from 'pg';
import {
  transitionTransport,
  transportEventAfterHreqChange,
  type HreqEvent,
  type HreqStatus,
  type RoundCounts,
  type TransportStatus,
} from '../../domain/stateMachine.js';
import type { EventRecord } from '../realtime/eventLog.js';

// 지금 회차에 남은 대기 요청과 아직 유효한 승인 수 (5분 판정은 DB 시각 now로)
export function roundCounts(
  requests: { status: HreqStatus }[],
  approvalValidUntil: Date,
  now: Date,
): RoundCounts {
  return {
    waiting: requests.filter((r) => r.status === 'waiting').length,
    validApproved: requests.filter((r) => r.status === 'approved' && now < approvalValidUntil)
      .length,
  };
}

export interface ReverseCascadeInput {
  transportId: string;
  transport: { status: TransportStatus; version: number };
  room: string; // team:{teamId}
  now: Date;
  changed: { event: HreqEvent; fromStatus: HreqStatus };
  counts: RoundCounts;
}

// 이송 건 상태가 바뀌면 DB에 반영하고 transport.status 이벤트를 돌려준다. 상태가 그대로면 null.
// (화면 갱신만 필요한 경우 — 첫 승인 알림 등 — 의 이벤트는 부르는 쪽이 따로 만든다)
export async function applyReverseCascade(
  client: pg.PoolClient,
  input: ReverseCascadeInput,
): Promise<EventRecord | null> {
  const { transportId, transport, now } = input;
  const next = transportEventAfterHreqChange(transport.status, input.changed, input.counts);
  if (!next) return null;

  const { to, history } = transitionTransport(transport.status, next.event, {
    now,
    version: transport.version,
    fallbackReason: next.reason,
  });
  if (to === transport.status) return null;

  const { rows } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, version = version + 1, last_activity_at = now(),
            fallback_reason = CASE WHEN $2::transport_status = 'fallback' THEN $3 ELSE fallback_reason END
      WHERE id = $1 RETURNING version`,
    [transportId, to, history.reason],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );
  transport.status = to;
  transport.version = rows[0].version;
  return {
    room: input.room,
    name: 'transport.status',
    entityType: 'transport',
    entityId: transportId,
    entityVersion: rows[0].version,
    payload: {
      transportId,
      status: to,
      event: history.event,
      reason: history.reason,
      byName: null,
    },
  };
}
