// 위치 이상치 (SFR-040): 직전 '정상' 좌표에서 초속 60m(시속 약 216km)보다 빠르게 움직인 것으로 계산되는 좌표는
// GPS 가 튄 것으로 보고 outlier 로 표시한다. 입구 200m 판정·이동 거리·익명 경로는 정상 좌표만 쓴다.
// - 비교 대상은 바로 앞 좌표가 아니라 '직전 정상 좌표'다. 튄 좌표 하나 뒤의 정상 좌표가 튄 좌표와 비교돼
//   덩달아 이상치가 되는 일을 막는다
// - 시간이 지날수록 허용 거리(60m × 초)가 늘어서, 첫 좌표가 틀렸어도 몇십 초 뒤 좌표부터는 다시 정상으로 잡힌다
import type pg from 'pg';
import { distanceM } from '../../domain/geo.js';

export const MAX_SPEED_MPS = 60;

export interface TimedPoint {
  lat: number;
  lng: number;
  recordedAt: Date;
}

// points 는 시각 순서. anchor 는 points 바로 앞의 정상 좌표(없으면 null). 좌표마다 이상치인지 돌려준다
export function flagOutliers(anchor: TimedPoint | null, points: TimedPoint[]): boolean[] {
  let last = anchor;
  return points.map((p) => {
    if (last) {
      const seconds = (p.recordedAt.getTime() - last.recordedAt.getTime()) / 1000;
      if (distanceM(last, p) > MAX_SPEED_MPS * seconds) return true;
    }
    last = p;
    return false;
  });
}

interface Row {
  lat: number;
  lng: number;
  recorded_at: Date;
  // DB 시각 원문. JS Date 는 밀리초까지라 마이크로초가 있는 값을 다시 찾으려면 원문으로 맞춰야 한다
  at_text: string;
  outlier: boolean;
}

// 좌표를 저장한 뒤 부른다 (같은 트랜잭션, 이송 건은 이미 잠겨 있음).
// 끊겼다 붙어서 늦게 온 좌표가 중간에 끼면 그 뒤 판정이 바뀔 수 있어, 이번에 들어온 가장 이른 시각부터 다시 판정한다.
// 이송 1건은 많아야 수백 점이라 매번 다시 봐도 가볍다. 판정이 바뀐 행만 고친다
export async function markOutliers(
  client: pg.PoolClient,
  transportId: string,
  fromAt: Date,
): Promise<void> {
  const { rows: anchorRows } = await client.query<Row>(
    `SELECT lat::float8 AS lat, lng::float8 AS lng, recorded_at, recorded_at::text AS at_text, outlier FROM location_point
      WHERE transport_id = $1 AND recorded_at < $2 AND NOT outlier
      ORDER BY recorded_at DESC LIMIT 1`,
    [transportId, fromAt],
  );
  const { rows } = await client.query<Row>(
    `SELECT lat::float8 AS lat, lng::float8 AS lng, recorded_at, recorded_at::text AS at_text, outlier FROM location_point
      WHERE transport_id = $1 AND recorded_at >= $2 ORDER BY recorded_at`,
    [transportId, fromAt],
  );
  const toPoint = (r: Row): TimedPoint => ({ lat: r.lat, lng: r.lng, recordedAt: r.recorded_at });
  const anchor = anchorRows[0] ? toPoint(anchorRows[0]) : null;
  const flags = flagOutliers(anchor, rows.map(toPoint));
  const changed = rows.filter((r, i) => r.outlier !== flags[i]);
  if (changed.length === 0) return;
  await client.query(
    `UPDATE location_point lp SET outlier = c.outlier
       FROM jsonb_to_recordset($2::jsonb) AS c(recorded_at timestamptz, outlier boolean)
      WHERE lp.transport_id = $1 AND lp.recorded_at = c.recorded_at`,
    [
      transportId,
      JSON.stringify(changed.map((r) => ({ recorded_at: r.at_text, outlier: !r.outlier }))),
    ],
  );
}
