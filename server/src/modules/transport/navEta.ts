// 이동 중 남은 시간 (SFR-121·132) + 입구 200m 안 알림 (SFR-144).
// 남은 시간은 앱 안 내비(카카오모빌리티 KNSDK)가 계산하고, 경로 안내 담당 단말이 위치를 올릴 때 같이 보낸다.
// 서버는 길찾기를 따로 부르지 않는다 (이동 중 길찾기 호출 없음, 기술정의서 v0.7).
import type pg from 'pg';
import { ambulanceNearEntrance } from '../hospital-web/confirmArrival.js';
import type { EventRecord } from '../realtime/eventLog.js';

// 보여 줄 남은 분 (SQL 식). t = transport, hr = 확정 병원 요청.
// - 이번 확정 뒤에 받은 내비 값이 있으면: 받은 값 − 받은 뒤 지난 분.
//   값이 1분마다 오면 거의 그대로 보이고, 2분 넘게 끊기면 '마지막 값에서 지난 시간을 뺀 값'이 된다 (SFR-121)
// - 아직 없으면: 확정 때 도착 예상 시간 − 확정 뒤 지난 분
// 0분 밑으로는 내려가지 않는다. 시각은 모두 DB now() 기준 (절대 규칙 6)
export const DISPLAY_ETA_SQL = `(CASE
    WHEN t.nav_eta_at IS NOT NULL AND t.nav_eta_at >= t.confirmed_at
      THEN GREATEST(0, t.nav_eta_min - floor(extract(epoch FROM now() - t.nav_eta_at) / 60))
    WHEN hr.eta_min IS NOT NULL AND t.confirmed_at IS NOT NULL
      THEN GREATEST(0, hr.eta_min - floor(extract(epoch FROM now() - t.confirmed_at) / 60))
  END)::int`;

interface ConfirmedTarget {
  request_id: string;
  hospital_id: string;
  team_id: string;
  old_eta: number | null;
  notified_near: boolean;
}

// 위치를 저장한 뒤 부른다 (같은 트랜잭션, 이송 건은 이미 잠겨 있음). 이동 중(moving)이고 확정 병원이 있을 때만.
// - etaMin 이 오면 저장하고, 보여 줄 분이 바뀌었을 때만 팀에 transport.eta, 병원에 incoming.updated (5초마다 보내지 않게)
// - 입구 200m 안에 처음 들어오면 병원에 incoming.near 한 번 → '도착 확인' 버튼이 켜진다
// 이벤트에는 ID·분만 넣는다. 구급차 좌표·거리는 병원으로 보내지 않는다 (절대 규칙 5, SFR-121)
export async function afterLocations(
  client: pg.PoolClient,
  transportId: string,
  etaMin: number | undefined,
): Promise<EventRecord[]> {
  const { rows } = await client.query<ConfirmedTarget>(
    `SELECT hr.id AS request_id, hr.hospital_id, t.team_id,
            CASE WHEN t.nav_eta_at >= t.confirmed_at THEN ${DISPLAY_ETA_SQL} END AS old_eta,
            coalesce(t.near_entrance_at >= t.confirmed_at, false) AS notified_near
       FROM transport t
       JOIN request_round r ON r.transport_id = t.id
       JOIN hospital_request hr ON hr.round_id = r.id AND hr.status = 'confirmed'
      WHERE t.id = $1 AND t.status = 'moving'`,
    [transportId],
  );
  const target = rows[0];
  // 다시 요청 중(확정 병원이 승인 취소)이면 남은 시간을 보여 줄 병원이 없다
  if (!target) return [];
  const requestId = Number(target.request_id);
  const events: EventRecord[] = [];

  if (etaMin !== undefined) {
    await client.query('UPDATE transport SET nav_eta_min = $2, nav_eta_at = now() WHERE id = $1', [
      transportId,
      etaMin,
    ]);
    if (target.old_eta !== etaMin) {
      const common = { entityType: 'transport', entityId: transportId };
      events.push(
        {
          room: `team:${target.team_id}`,
          name: 'transport.eta',
          ...common,
          payload: { transportId, etaMin },
        },
        {
          room: `hospital:${target.hospital_id}`,
          name: 'incoming.updated',
          ...common,
          payload: { requestId, etaMin },
        },
      );
    }
  }

  if (!target.notified_near) {
    const near = await ambulanceNearEntrance(client, transportId, Number(target.hospital_id));
    if (near === true) {
      await client.query('UPDATE transport SET near_entrance_at = now() WHERE id = $1', [
        transportId,
      ]);
      events.push({
        room: `hospital:${target.hospital_id}`,
        name: 'incoming.near',
        entityType: 'transport',
        entityId: transportId,
        payload: { requestId },
      });
    }
  }
  return events;
}
