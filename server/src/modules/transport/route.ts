// 이송 중 위치 기록과 익명 이송 경로 (SFR-037·039·041, SER-002, DAR-014).
// - 이동 중 담당 단말이 5초마다 좌표를 올리면 location_point 에 쌓는다
// - 이송이 끝나면(도착·취소·이전 이송 끝내기) 같은 트랜잭션에서 익명 경로로 옮기고 원본은 바로 지운다.
//   익명 경로에는 대원·팀·이송 건 연결이 없다. 이송 건에는 이동 거리만 남긴다 (구급활동일지 초안용)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { isInKorea } from '../../domain/geo.js';
import { ACTIVE, type TransportStatus } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { lockMyTransport, transportIdParam } from './access.js';

interface PointRow {
  lat: number;
  lng: number;
  speed_kmh: number | null;
  recorded_at: Date;
}

// 두 좌표 사이 직선거리(m). 5초 간격이라 구간마다 직선으로 이어도 실제 거리와 거의 같다
function meters(a: PointRow, b: PointRow): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function routeDistanceM(points: PointRow[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += meters(points[i - 1], points[i]);
  return Math.round(total);
}

// 이송이 끝날 때 부른다. 이송 건 행은 부르는 쪽이 이미 잠갔다 (stateMachine.ts 규칙 5).
// 위치 기록이 없으면(위치 미동의·출발 전 종료) 익명 경로를 만들지 않고 null (SFR-041)
export async function closeRoute(
  client: pg.PoolClient,
  transportId: string,
  ending: { cancelled: boolean },
): Promise<{ distanceM: number } | null> {
  const { rows: points } = await client.query<PointRow>(
    `SELECT lat::float8 AS lat, lng::float8 AS lng, speed_kmh::float8 AS speed_kmh, recorded_at
       FROM location_point WHERE transport_id = $1 ORDER BY recorded_at`,
    [transportId],
  );
  if (points.length === 0) return null;

  const { rows } = await client.query<{ departed_at: Date | null; hospital_id: string | null }>(
    'SELECT departed_at, confirmed_hospital_id AS hospital_id FROM transport WHERE id = $1',
    [transportId],
  );
  const { departed_at: departedAt, hospital_id: hospitalId } = rows[0];
  const start = (departedAt ?? points[0].recorded_at).getTime();
  const distanceM = routeDistanceM(points);

  // 좌표 열: [위도, 경도, 출발 후 초, 속도]. 절대 시각 대신 출발 후 초만 남겨 원본 이송과 맞추기 어렵게 한다
  const series = points.map((p) => [
    p.lat,
    p.lng,
    Math.max(0, Math.round((p.recorded_at.getTime() - start) / 1000)),
    p.speed_kmh,
  ]);
  await client.query(
    `INSERT INTO anonymous_route (hospital_id, departed_at, ended_at, cancelled, distance_m, points)
     VALUES ($1, $2, now(), $3, $4, $5)`,
    [hospitalId, departedAt, ending.cancelled, distanceM, JSON.stringify(series)],
  );
  await client.query('UPDATE transport SET distance_m = $2 WHERE id = $1', [
    transportId,
    distanceM,
  ]);
  // 원본은 바로 지운다 (SER-002). 같은 트랜잭션이라 익명 경로 저장이 실패하면 지우지도 않는다
  await client.query('DELETE FROM location_point WHERE transport_id = $1', [transportId]);
  return { distanceM };
}

// ---------- 위치 올리기 API (SFR-037, 담당 단말 1대만) ----------

const pointSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  speedKmh: z.number().min(0).max(300).nullish(),
  recordedAt: z.iso.datetime({ offset: true }),
});
const locationsSchema = z.object({
  deviceId: z.string().min(1).max(80),
  // 5초마다 1개가 기본. 잠깐 끊겼다 붙으면 모아 둔 것을 한 번에 보낸다 (10분치까지)
  points: z.array(pointSchema).min(1).max(120),
});

export async function recordLocations(
  client: pg.PoolClient,
  input: {
    transportId: string;
    paramedicId: string;
    deviceId: string;
    points: z.infer<typeof pointSchema>[];
  },
): Promise<number> {
  const { transportId } = input;
  // 내 팀 이송 건만. 같은 이송 건의 위치 올리기·도착·취소가 한 줄로 선다 (규칙 5)
  await lockMyTransport(client, transportId, input.paramedicId);
  const { rows } = await client.query<{
    status: TransportStatus;
    location_consent: boolean;
    departed_at: Date | null;
    nav_device_id: string | null;
  }>('SELECT status, location_consent, departed_at, nav_device_id FROM transport WHERE id = $1', [
    transportId,
  ]);
  const t = rows[0];
  // 출발한 뒤 이송이 끝날 때까지만. 다시 요청으로 '요청 중'이 되어도 계속 받는다 (SFR-037).
  // 위치 미동의 건은 앱이 부르지 않지만, 와도 저장하지 않는다 (SFR-041)
  if (!t.location_consent || t.departed_at === null || !ACTIVE.includes(t.status)) {
    throw new AppError(409, 'INVALID_TRANSITION', '지금은 위치를 기록하지 않아요', {
      status: t.status,
    });
  }

  // 담당 단말 1대만 기록한다 (SFR-036·037). 담당을 정하는 흐름(SFR-132)이 생기기 전까지는
  // 출발 뒤 처음 위치를 보낸 단말이 담당이 된다. 행을 잠근 뒤라 두 단말이 동시에 보내도 한 대만 된다
  if (t.nav_device_id === null) {
    await client.query('UPDATE transport SET nav_device_id = $2 WHERE id = $1', [
      transportId,
      input.deviceId,
    ]);
  } else if (t.nav_device_id !== input.deviceId) {
    throw new AppError(403, 'NOT_NAV_DEVICE', '경로 안내 담당 단말만 위치를 기록해요');
  }

  for (const p of input.points) {
    if (!isInKorea(p.lat, p.lng)) {
      throw new AppError(400, 'VALIDATION_FAILED', '좌표 범위 오류: 대한민국 밖 좌표예요', {
        fields: ['points'],
        reason: 'coords_out_of_korea',
      });
    }
  }
  // 출발 1분 전 ~ 지금+1분(DB 시각) 밖의 기록은 단말 시계가 틀린 것으로 보고 버린다.
  // 같은 시각을 다시 보내면(재전송) 한 번만 저장한다
  const { rowCount } = await client.query(
    `INSERT INTO location_point (transport_id, device_id, lat, lng, speed_kmh, recorded_at)
     SELECT $1, $2, p.lat, p.lng, p.speed_kmh, p.recorded_at
       FROM jsonb_to_recordset($3::jsonb) AS p(lat numeric, lng numeric, speed_kmh numeric, recorded_at timestamptz)
      WHERE p.recorded_at BETWEEN $4::timestamptz - interval '1 minute' AND now() + interval '1 minute'
     ON CONFLICT (transport_id, recorded_at) DO NOTHING`,
    [
      transportId,
      input.deviceId,
      JSON.stringify(
        input.points.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          speed_kmh: p.speedKmh ?? null,
          recorded_at: p.recordedAt,
        })),
      ),
      t.departed_at,
    ],
  );
  // 위치 기록은 '활동'에 넣지 않는다 (SFR-086 2시간 자동 종료는 위치 기록 제외)
  return rowCount ?? 0;
}

export function locationRouter(pool: pg.Pool, guards: RequestHandler[]): Router {
  const router = Router();
  router.post('/transports/:transportId/locations', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const input = parseBody(locationsSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    await withTransaction(pool, (client) =>
      recordLocations(client, {
        transportId,
        paramedicId,
        deviceId: input.deviceId,
        points: input.points,
      }),
    );
    res.status(204).end();
  });
  return router;
}
