// 자동 반경 넓히기 (D-142, SFR-131): 승인이 0곳인 채로 요청이 모두 닫혀 '예비 추천'이 된 이송 건을
// 서버가 찾아, 다음 반경에서 이번 이송에 아직 요청하지 않은 병원에만 새 회차를 보낸다. 대원이 누르지 않아도 된다.
//
// - 대상: 전부 거절(all_rejected) · 2분 동안 승인 0곳(expired_no_approval) · 전달 0곳(none_delivered).
//   승인이 있었다가 5분이 지난 경우·전화 확인에서 돌아온 경우·대원이 끈 경우는 건드리지 않는다
// - 새 병원이 없는 반경은 건너뛴다. 등급별 최대(대학병원급 80km · 나머지 40km)까지 없으면 auto_expand 를 끄고
//   예비 추천에 그대로 둔다 (가까운 병원에 전화로 확인 안내)
// - 주기 작업(몇 초마다)이 부른다. 행을 잠그고 다시 확인하므로 서버가 2대여도 한 번만 넓힌다 (절대 규칙 7·8)
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { autoRadiusSteps, maxRadiusFor } from '../../domain/geo.js';
import { transitionTransport, type TransportStatus } from '../../domain/stateMachine.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import { findRequestTargets, insertRound } from './requestTargets.js';

/** 승인이 한 번도 없이 요청이 모두 닫혔을 때만 자동으로 넓힌다 */
export const AUTO_EXPAND_REASONS = ['all_rejected', 'expired_no_approval', 'none_delivered'];

export interface AutoExpandResult {
  events: LoggedEvent[];
  /** 새로 보낸 회차 (2분·5분 타이머·길찾기를 커밋 뒤에 건다) */
  roundIds: string[];
}

interface Row {
  status: TransportStatus;
  version: number;
  team_id: string;
  request_radius_km: number;
  requested_grade: number | null;
  origin_lat: number | null;
  origin_lng: number | null;
  fallback_reason: string | null;
  auto_expand: boolean;
}

/** 한 이송 건을 넓혀 본다. 넓혔으면 회차 ID, 더 넓힐 데가 없으면 null (auto_expand 를 끈다) */
export async function autoExpandOne(
  client: pg.PoolClient,
  transportId: string,
): Promise<{ roundId: string; events: LoggedEvent[] } | null> {
  const { rows } = await client.query<Row>(
    `SELECT status, version, team_id, request_radius_km, requested_grade,
            origin_lat::float8 AS origin_lat, origin_lng::float8 AS origin_lng, fallback_reason, auto_expand
       FROM transport WHERE id = $1 FOR UPDATE`,
    [transportId],
  );
  const t = rows[0];
  // 잠그는 사이 대원이 먼저 넓혔거나·취소했거나·전화 확인으로 갔으면 그만둔다
  if (
    !t ||
    t.status !== 'fallback' ||
    !t.auto_expand ||
    !AUTO_EXPAND_REASONS.includes(t.fallback_reason ?? '')
  )
    return null;

  const stop = async () => {
    await client.query('UPDATE transport SET auto_expand = false WHERE id = $1', [transportId]);
    return null;
  };
  if (t.origin_lat === null || t.origin_lng === null) return stop();

  const max = maxRadiusFor(t.requested_grade);
  const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
  const now = clock[0].now;
  // 지금보다 넓고 최대 안인 반경을 차례로: 새 병원이 있는 첫 반경으로 넓힌다
  for (const radiusKm of autoRadiusSteps(t.requested_grade)) {
    if (radiusKm <= t.request_radius_km || radiusKm > max) continue;
    const targets = await findRequestTargets(client, {
      lat: t.origin_lat,
      lng: t.origin_lng,
      radiusKm,
      grade: t.requested_grade,
      transport: { id: transportId, skipAlreadyRequested: true },
    });
    if (targets.length === 0) continue;

    const { to, history } = transitionTransport(t.status, 'AUTO_EXPAND_ROUND', {
      now,
      version: t.version,
      currentRadiusKm: t.request_radius_km,
      nextRadiusKm: radiusKm,
      maxRadiusKm: max,
      newTargetCount: targets.length,
    });
    const { rows: updated } = await client.query<{ version: number }>(
      `UPDATE transport
          SET status = $2, request_radius_km = $3, fallback_reason = NULL,
              last_activity_at = now(), version = version + 1
        WHERE id = $1 RETURNING version`,
      [transportId, to, radiusKm],
    );
    await client.query(
      `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [transportId, history.from, history.to, history.event, history.reason, history.at],
    );
    const version = updated[0].version;
    const round = await insertRound(client, {
      transportId,
      kind: 'expand',
      radiusKm,
      targets,
      now,
      entityVersion: version,
    });
    const room = `team:${t.team_id}`;
    const records: EventRecord[] = [
      {
        room,
        name: 'transport.status',
        entityType: 'transport',
        entityId: transportId,
        entityVersion: version,
        payload: {
          transportId,
          status: to,
          event: history.event,
          reason: history.reason,
          byName: null,
        },
      },
      { ...round.event, room },
    ];
    return { roundId: round.roundId, events: await appendEvents(client, records) };
  }
  return stop();
}

/** 주기 작업: 자동으로 넓힐 이송 건을 찾아 한 건씩 (각각 따로 트랜잭션) */
export async function runAutoExpand(pool: pg.Pool): Promise<AutoExpandResult> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM transport
      WHERE status = 'fallback' AND auto_expand AND fallback_reason = ANY($1::text[])
      ORDER BY last_activity_at LIMIT 20`,
    [AUTO_EXPAND_REASONS],
  );
  const result: AutoExpandResult = { events: [], roundIds: [] };
  for (const { id } of rows) {
    const done = await withTransaction(pool, (client) => autoExpandOne(client, id));
    if (done) {
      result.events.push(...done.events);
      result.roundIds.push(done.roundId);
    }
  }
  return result;
}
