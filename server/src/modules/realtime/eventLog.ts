// 실시간 이벤트 기록 (outbox). 상태를 바꾸는 트랜잭션 안에서 event_log에 먼저 쓰고, 커밋된 뒤에만 방으로 보낸다.
// 그래서 롤백된 변경이 앱에 알려지는 일이 없고, 끊겼다 다시 붙은 앱은 seq 순서대로 놓친 이벤트를 다시 받는다.
import type pg from 'pg';

// 이벤트를 쓰는 트랜잭션끼리 이 잠금을 잡고 한 줄로 선다 → seq 순서 = 커밋 순서 (빈틈 없이 다시 보내기)
const EVENT_LOG_LOCK = 7401;

type PayloadValue = string | number | boolean | null | number[];

export interface EventRecord {
  room: string; // team:12 / hospital:3 / paramedic:7
  name: string; // transport.created ...
  entityType?: string;
  entityId?: string;
  entityVersion?: number;
  // ID·개수·시각만 넣는다. 환자 평가 정보는 절대 넣지 않는다 (절대 규칙 5, SER-014)
  payload: Record<string, PayloadValue>;
}

// DB에 기록된 이벤트. 커밋한 뒤 이걸 그대로 보낸다
export interface LoggedEvent {
  seq: number;
  room: string;
  name: string;
  entityVersion: number | null;
  payload: Record<string, PayloadValue>;
  occurredAt: Date;
}

interface EventRow {
  seq: string;
  room: string;
  name: string;
  entity_version: number | null;
  payload: Record<string, PayloadValue>;
  occurred_at: Date;
}

export function fromRow(row: EventRow): LoggedEvent {
  return {
    seq: Number(row.seq),
    room: row.room,
    name: row.name,
    entityVersion: row.entity_version,
    payload: row.payload,
    occurredAt: row.occurred_at,
  };
}

export const EVENT_COLUMNS = 'seq, room, name, entity_version, payload, occurred_at';

export async function appendEvents(
  client: pg.PoolClient,
  events: EventRecord[],
): Promise<LoggedEvent[]> {
  if (events.length === 0) return [];
  await client.query('SELECT pg_advisory_xact_lock($1)', [EVENT_LOG_LOCK]);
  const logged: LoggedEvent[] = [];
  for (const e of events) {
    const { rows } = await client.query<EventRow>(
      `INSERT INTO event_log (room, name, entity_type, entity_id, entity_version, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${EVENT_COLUMNS}`,
      [
        e.room,
        e.name,
        e.entityType ?? null,
        e.entityId ?? null,
        e.entityVersion ?? null,
        e.payload,
      ],
    );
    logged.push(fromRow(rows[0]));
  }
  return logged;
}

// shared/events.ts의 Envelope 모양. serverNow는 보내는 순간의 서버 시각 (화면 표시용)
export function toEnvelope(event: LoggedEvent) {
  return {
    seq: event.seq,
    room: event.room,
    occurredAt: event.occurredAt.toISOString(),
    serverNow: new Date().toISOString(),
    ...(event.entityVersion === null ? {} : { entityVersion: event.entityVersion }),
    data: event.payload,
  };
}
