// 실시간 이벤트 기록 (outbox). 상태를 바꾸는 트랜잭션 안에서 event_log에 먼저 쓰고, 커밋된 뒤에만 방으로 보낸다.
// 그래서 롤백된 변경이 앱에 알려지는 일이 없고, 끊겼다 다시 붙은 앱은 seq 순서대로 놓친 이벤트를 다시 받는다.
// 소켓으로 실제 보내는 일은 실시간 모듈(Socket.IO)이 맡는다. 여기서는 기록만 한다.
import type pg from 'pg';

// 이벤트를 쓰는 트랜잭션끼리 이 잠금을 잡고 한 줄로 선다 → seq 순서 = 커밋 순서 (빈틈 없이 다시 보내기)
const EVENT_LOG_LOCK = 7401;

export interface EventRecord {
  room: string; // team:12 / hospital:3 / paramedic:7
  name: string; // transport.created ...
  entityType?: string;
  entityId?: string;
  entityVersion?: number;
  // ID·개수·시각만 넣는다. 환자 평가 정보는 절대 넣지 않는다 (절대 규칙 5, SER-014)
  payload: Record<string, string | number | boolean | null>;
}

export async function appendEvents(client: pg.PoolClient, events: EventRecord[]): Promise<void> {
  if (events.length === 0) return;
  await client.query('SELECT pg_advisory_xact_lock($1)', [EVENT_LOG_LOCK]);
  for (const e of events) {
    await client.query(
      `INSERT INTO event_log (room, name, entity_type, entity_id, entity_version, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        e.room,
        e.name,
        e.entityType ?? null,
        e.entityId ?? null,
        e.entityVersion ?? null,
        e.payload,
      ],
    );
  }
}
