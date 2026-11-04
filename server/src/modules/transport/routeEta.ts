// 요청용 도착 예상 시간 갱신 (SFR-129, INR-002): 요청을 보낼 때는 직선거리 ÷ 40km/h 추정값을 먼저 붙인다.
// 그 뒤 반경 10km 안 병원만 길찾기를 한 번에 불러 결과가 온 병원의 값을 바꾸고, 팀과 그 병원에 알린다.
// 10km 밖이거나 길찾기가 실패한 병원은 추정값을 그대로 둔다 (화면에 '추정'). 상태 변경이 아니라 version은 그대로다.
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { EtaLookup } from './eta.js';

export const ROUTE_ETA_RADIUS_KM = 10;

export async function refineRoundEtas(
  pool: pg.Pool,
  eta: EtaLookup,
  roundId: string,
): Promise<LoggedEvent[]> {
  // 아직 응답 중인 요청만 (대기·승인). 출발점에서 직선 10km 안 (추천과 같은 하버사인)
  const { rows } = await pool.query<{
    id: string;
    hospital_id: string;
    lat: number;
    lng: number;
    origin_lat: number;
    origin_lng: number;
    transport_id: string;
    team_id: string | null;
  }>(
    `SELECT hr.id, hr.hospital_id, h.lat::float8 AS lat, h.lng::float8 AS lng,
            t.origin_lat::float8 AS origin_lat, t.origin_lng::float8 AS origin_lng, t.id AS transport_id, t.team_id
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       JOIN transport t ON t.id = r.transport_id
       JOIN hospital h ON h.id = hr.hospital_id
      WHERE hr.round_id = $1 AND hr.status IN ('waiting', 'approved') AND t.origin_lat IS NOT NULL
        AND 2 * 6371 * asin(sqrt(
              power(sin(radians(h.lat::float8 - t.origin_lat::float8) / 2), 2)
              + cos(radians(t.origin_lat::float8)) * cos(radians(h.lat::float8))
                * power(sin(radians(h.lng::float8 - t.origin_lng::float8) / 2), 2))) <= $2
      ORDER BY hr.id`,
    [roundId, ROUTE_ETA_RADIUS_KM],
  );
  if (rows.length === 0) return [];

  const origin = { lat: rows[0].origin_lat, lng: rows[0].origin_lng };
  // 길찾기는 실패해도 예외를 던지지 않고 그 병원만 빠진다 (SFR-073과 같은 함수)
  const minutes = await eta(
    origin,
    rows.map((r) => ({ id: r.hospital_id, lat: r.lat, lng: r.lng })),
  );
  const found = rows.filter((r) => minutes.has(r.hospital_id));
  if (found.length === 0) return [];

  return withTransaction(pool, async (client) => {
    const events: EventRecord[] = [];
    for (const r of found) {
      const etaMin = minutes.get(r.hospital_id)!;
      // 길찾기를 기다리는 사이 닫힌 요청(확정·취소·만료)은 건드리지 않는다
      const { rows: updated } = await client.query(
        `UPDATE hospital_request SET eta_min = $2, eta_source = 'route', updated_at = now()
          WHERE id = $1 AND status IN ('waiting', 'approved') RETURNING id`,
        [r.id, etaMin],
      );
      if (!updated[0]) continue;
      if (r.team_id) {
        events.push({
          room: `team:${r.team_id}`,
          name: 'request.eta',
          entityType: 'hospital_request',
          entityId: r.id,
          payload: {
            transportId: r.transport_id,
            hospitalRequestId: Number(r.id),
            etaMin,
            etaSource: 'route',
          },
        });
      }
      events.push({
        room: `hospital:${r.hospital_id}`,
        name: 'request.eta',
        entityType: 'hospital_request',
        entityId: r.id,
        payload: { requestId: Number(r.id), etaMin, etaSource: 'route' },
      });
    }
    return appendEvents(client, events);
  });
}
