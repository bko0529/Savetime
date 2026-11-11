// SFR-037 위치 기록 · SFR-039 소요시간 익명 저장 · SFR-041 익명화(원본 즉시 삭제)를 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, ORIGIN, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';
import { routeDistanceM } from './route.js';

function post(ctx: AuthContext, token: string, path: string, body: object) {
  return request(appFor(ctx))
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}
const locations = (ctx: AuthContext, s: Scene, body: object, token = s.kim) =>
  post(ctx, token, `/transports/${s.transportId}/locations`, body);

// B병원으로 확정해 이동 중(출발 시각 기록)으로 만든다
async function moving(ctx: AuthContext, s: Scene): Promise<number> {
  clock.base = Date.now() - 55_000;
  clock.n = 0;
  const res = await post(ctx, s.kim, `/transports/${s.transportId}/confirm`, {
    hospitalRequestId: s.req['B병원'],
    version: 1,
  }).set('Idempotency-Key', randomUUID());
  assert.equal(res.status, 200);
  return res.body.version;
}

// 출발 위치에서 북쪽으로 dLat씩. 시각은 테스트마다 출발 55초 전부터 20초씩 늘어난다.
// 서버는 출발 1분 전 ~ 지금+1분 기록만 받으므로 한 테스트에서 6점까지 쓸 수 있다.
// 20초 간격이면 0.01도(≈1.1km)를 가도 초속 56m라 이상치(초속 60m 초과, SFR-040)가 아니다
const clock = { base: Date.now(), n: 0 };
function track(...dLats: number[]) {
  return dLats.map((d) => ({
    lat: ORIGIN.lat + d,
    lng: ORIGIN.lng,
    speedKmh: 40,
    recordedAt: new Date(clock.base + clock.n++ * 20_000).toISOString(),
  }));
}

async function counts(pool: pg.Pool, transportId: string) {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM location_point WHERE transport_id = $1) AS points,
            (SELECT count(*)::int FROM anonymous_route) AS routes,
            (SELECT distance_m FROM transport WHERE id = $1) AS distance_m,
            (SELECT nav_device_id FROM transport WHERE id = $1) AS nav_device_id`,
    [transportId],
  );
  return rows[0];
}

test('이동 거리는 구간 직선거리의 합이다', () => {
  const p = (lat: number) => ({ lat, lng: 127, speed_kmh: null, recorded_at: new Date() });
  assert.equal(routeDistanceM([p(36)]), 0);
  // 위도 0.01도 ≈ 1112m
  assert.equal(Math.round(routeDistanceM([p(36), p(36.01), p(36.02)]) / 10), 222);
});

test('이동 중 담당 단말 위치를 쌓고, 도착하면 익명 경로로 옮기고 원본을 지운다 (SFR-037·039·041)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const version = await moving(ctx, s);

    const res = await locations(ctx, s, { deviceId: 'device-kim01', points: track(0, 0.01) });
    assert.equal(res.status, 204);
    // 처음 보낸 단말이 담당이 된다 (SFR-132 전까지)
    assert.deepEqual(await counts(ctx.pool, s.transportId), {
      points: 2,
      routes: 0,
      distance_m: null,
      nav_device_id: 'device-kim01',
    });
    const more = await locations(ctx, s, {
      deviceId: 'device-kim01',
      points: track(0.02),
    });
    assert.equal(more.status, 204);

    const arrived = await post(ctx, s.kim, `/transports/${s.transportId}/arrive`, {
      method: 'button',
      version,
    });
    assert.equal(arrived.status, 200);
    assert.equal(arrived.body.distanceKm, 2.2);

    // 원본 삭제, 이송 건에는 이동 거리만 (SER-002)
    const after = await counts(ctx.pool, s.transportId);
    assert.equal(after.points, 0);
    assert.equal(after.routes, 1);
    assert.ok(Math.abs(after.distance_m - 2224) < 5);

    // 익명 경로: 목적 병원·출발·도착 시각·좌표 열·거리만. 대원·팀·이송 건 칸이 없다 (DAR-014)
    const { rows } = await ctx.pool.query(
      `SELECT a.*, h.name AS hospital_name FROM anonymous_route a JOIN hospital h ON h.id = a.hospital_id`,
    );
    const route = rows[0];
    assert.equal(route.hospital_name, 'B병원');
    assert.equal(route.cancelled, false);
    assert.ok(route.departed_at instanceof Date);
    assert.equal(route.points.length, 3);
    assert.deepEqual(route.points[0].slice(0, 2), [ORIGIN.lat, ORIGIN.lng]);
    assert.ok(route.points.every((p: number[]) => p[2] >= 0));
    assert.deepEqual(
      Object.keys(route)
        .filter((k) => /transport|team|paramedic|device/.test(k))
        .sort(),
      [],
    );
  });
});

test('위치 올리기: 담당 단말만 · 출발 전·미동의·끝난 건은 거절 · 재전송은 한 번만 · 다시 요청 중에도 계속', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);

    // 출발 전 (요청 중)
    const early = await locations(ctx, s, { deviceId: 'device-kim01', points: track(0) });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'INVALID_TRANSITION');

    await moving(ctx, s);
    const first = track(0, 0.001);
    assert.equal(
      (await locations(ctx, s, { deviceId: 'device-kim01', points: first })).status,
      204,
    );

    // 다른 단말(팀원 폰)은 보기 전용
    const other = await locations(ctx, s, { deviceId: 'device-lee01', points: track(0) }, s.lee);
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, 'NOT_NAV_DEVICE');

    // 같은 시각을 다시 보내도 한 번만 저장
    await locations(ctx, s, { deviceId: 'device-kim01', points: first });
    assert.equal((await counts(ctx.pool, s.transportId)).points, 2);

    // 단말 시계가 크게 틀린 기록(1시간 뒤)은 버린다
    await locations(ctx, s, {
      deviceId: 'device-kim01',
      points: [
        {
          lat: ORIGIN.lat,
          lng: ORIGIN.lng,
          recordedAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });
    assert.equal((await counts(ctx.pool, s.transportId)).points, 2);

    // 대한민국 밖 좌표·잘못된 형식
    const outside = await locations(ctx, s, {
      deviceId: 'device-kim01',
      points: [{ lat: 35, lng: 140, recordedAt: new Date().toISOString() }],
    });
    assert.equal(outside.status, 400);
    assert.equal((await locations(ctx, s, { deviceId: 'device-kim01', points: [] })).status, 400);

    // 승인 취소 뒤 다시 요청으로 '요청 중'이 되어도 계속 기록한다 (SFR-037)
    await ctx.pool.query(`UPDATE transport SET status = 'requesting' WHERE id = $1`, [
      s.transportId,
    ]);
    const reRequest = await locations(ctx, s, {
      deviceId: 'device-kim01',
      points: track(0.002),
    });
    assert.equal(reRequest.status, 204);

    // 위치 미동의 건은 저장하지 않는다 (SFR-041)
    await ctx.pool.query('UPDATE transport SET location_consent = false WHERE id = $1', [
      s.transportId,
    ]);
    const noConsent = await locations(ctx, s, { deviceId: 'device-kim01', points: track(0.003) });
    assert.equal(noConsent.status, 409);
  });
});

test('이동 중 취소해도 익명 경로(취소 표시)로 옮기고 원본을 지운다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const version = await moving(ctx, s);
    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0, 0.01) });

    const cancelled = await post(ctx, s.kim, `/transports/${s.transportId}/cancel`, { version });
    assert.equal(cancelled.status, 200);
    const after = await counts(ctx.pool, s.transportId);
    assert.equal(after.points, 0);
    assert.equal(after.routes, 1);
    const { rows } = await ctx.pool.query('SELECT cancelled FROM anonymous_route');
    assert.equal(rows[0].cancelled, true);

    // 끝난 건에는 더 올릴 수 없다
    const late = await locations(ctx, s, { deviceId: 'device-kim01', points: track(0.02) });
    assert.equal(late.status, 409);
  });
});

test('위치 기록이 없으면 익명 경로를 만들지 않고 이동 거리도 없다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const version = await moving(ctx, s);
    const arrived = await post(ctx, s.kim, `/transports/${s.transportId}/arrive`, {
      method: 'menu',
      version,
    });
    assert.equal(arrived.status, 200);
    assert.equal(arrived.body.distanceKm, null);
    assert.deepEqual(await counts(ctx.pool, s.transportId), {
      points: 0,
      routes: 0,
      distance_m: null,
      // 운전자가 확정해 그 단말이 담당이다. 위치를 안 보냈을 뿐 (SFR-132)
      nav_device_id: 'device-kim01',
    });
  });
});

test("도착을 잊고 새로 요청하면('이전 이송 끝내기') 이전 건의 위치도 익명 경로로 옮긴다", async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const version = await moving(ctx, s);
    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0, 0.01) });

    const next = await post(ctx, s.kim, '/transports', {
      id: randomUUID(),
      finishPrevious: true,
      previousVersion: version,
      radiusKm: 20,
      location: ORIGIN,
      locationConsent: true,
      assessment: { chiefComplaint: '호흡곤란' },
    });
    assert.equal(next.status, 201);
    const after = await counts(ctx.pool, s.transportId);
    assert.equal(after.points, 0);
    assert.equal(after.routes, 1);
    assert.ok(after.distance_m > 1000);
  });
});

async function eventNames(pool: pg.Pool, since: number) {
  const { rows } = await pool.query<{
    room: string;
    name: string;
    payload: Record<string, unknown>;
  }>('SELECT room, name, payload FROM event_log WHERE seq > $1 ORDER BY seq', [since]);
  return rows;
}
async function lastSeq(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query('SELECT coalesce(max(seq), 0)::int AS n FROM event_log');
  return rows[0].n;
}
const currentEta = async (ctx: AuthContext, s: Scene) =>
  (
    await request(appFor(ctx))
      .get('/api/v1/transports/current')
      .set('Authorization', `Bearer ${s.lee}`)
  ).body.etaMin;

test('담당 단말이 내비 남은 시간을 보내면 팀원 화면·병원 도착 예정에 같은 값, 바뀔 때만 알린다 (SFR-121·132)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await moving(ctx, s);
    const { rows: b } = await ctx.pool.query("SELECT id FROM hospital WHERE name = 'B병원'");

    let since = await lastSeq(ctx.pool);
    const first = await locations(ctx, s, {
      deviceId: 'device-kim01',
      points: track(0),
      etaMin: 12,
    });
    assert.equal(first.status, 204);
    // 팀원(이서준) 화면도 같은 값
    assert.equal(await currentEta(ctx, s), 12);
    const sent = await eventNames(ctx.pool, since);
    const teamRoom = sent.find((e) => e.name === 'transport.eta')!;
    assert.match(teamRoom.room, /^team:/);
    assert.deepEqual(teamRoom.payload, { transportId: s.transportId, etaMin: 12 });
    const hospital = sent.find((e) => e.name === 'incoming.updated')!;
    assert.equal(hospital.room, `hospital:${b[0].id}`);
    assert.deepEqual(hospital.payload, { requestId: s.req['B병원'], etaMin: 12 });
    // 병원으로 가는 이벤트에 구급차 좌표는 없다
    assert.doesNotMatch(JSON.stringify(sent), /lat|lng/);

    // 같은 분이면 다시 알리지 않는다 (5초마다 보내지 않게)
    since = await lastSeq(ctx.pool);
    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0.001), etaMin: 12 });
    assert.deepEqual(await eventNames(ctx.pool, since), []);
    // 바뀌면 알린다
    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0.002), etaMin: 11 });
    assert.deepEqual(
      (await eventNames(ctx.pool, since)).map((e) => e.name),
      ['transport.eta', 'incoming.updated'],
    );
  });
});

test('남은 시간이 2분 넘게 안 오면 마지막 값에서 지난 분을 빼고, 한 번도 안 왔으면 확정 때 값에서 뺀다 (SFR-121)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await moving(ctx, s);
    // 아직 내비 값이 없음: 확정 때 도착 예상 시간 − 확정 뒤 지난 분
    await ctx.pool.query('UPDATE hospital_request SET eta_min = 9 WHERE id = $1', [s.req['B병원']]);
    await ctx.pool.query(
      "UPDATE transport SET confirmed_at = now() - interval '2 minutes 10 seconds' WHERE id = $1",
      [s.transportId],
    );
    assert.equal(await currentEta(ctx, s), 7);

    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0), etaMin: 12 });
    // 3분 동안 값이 안 왔다 (단말 통신 끊김). 확정은 그보다 먼저였다
    await ctx.pool.query(
      `UPDATE transport SET nav_eta_at = now() - interval '3 minutes 5 seconds',
              confirmed_at = now() - interval '10 minutes' WHERE id = $1`,
      [s.transportId],
    );
    assert.equal(await currentEta(ctx, s), 9);
    // 0분 밑으로는 내려가지 않는다
    await ctx.pool.query(
      "UPDATE transport SET nav_eta_at = now() - interval '30 minutes' WHERE id = $1",
      [s.transportId],
    );
    assert.equal(await currentEta(ctx, s), 0);
  });
});

test('담당 단말이 아니면 남은 시간도 받지 않고, 범위 밖 값은 400', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await moving(ctx, s);
    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0) });
    const other = await locations(
      ctx,
      s,
      { deviceId: 'device-lee01', points: track(0.001), etaMin: 3 },
      s.lee,
    );
    assert.equal(other.status, 403);
    const bad = await locations(ctx, s, {
      deviceId: 'device-kim01',
      points: track(0.001),
      etaMin: -1,
    });
    assert.equal(bad.status, 400);
    const { rows } = await ctx.pool.query('SELECT nav_eta_min FROM transport WHERE id = $1', [
      s.transportId,
    ]);
    assert.equal(rows[0].nav_eta_min, null);
  });
});

test('구급차가 확정 병원 입구 200m 안에 처음 들어오면 병원 웹에 incoming.near 를 한 번만 보낸다 (SFR-144)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await moving(ctx, s);
    const { rows: b } = await ctx.pool.query("SELECT id FROM hospital WHERE name = 'B병원'");
    const nearOnes = async () =>
      (await eventNames(ctx.pool, 0)).filter((e) => e.name === 'incoming.near');

    // B병원은 출발지에서 북쪽 0.02도(약 2.2km). 아직 멀다
    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0.01) });
    assert.deepEqual(await nearOnes(), []);
    // 입구 앞
    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0.0199) });
    assert.deepEqual(await nearOnes(), [
      {
        room: `hospital:${b[0].id}`,
        name: 'incoming.near',
        payload: { requestId: s.req['B병원'] },
      },
    ]);
    // 계속 입구 근처에 있어도 다시 보내지 않는다
    await locations(ctx, s, { deviceId: 'device-kim01', points: track(0.02) });
    assert.equal((await nearOnes()).length, 1);
  });
});

test('튄 좌표(초속 60m 초과)는 입구 판정·이동 거리에서 빼고, 늦게 온 좌표가 끼면 다시 판정한다 (SFR-040)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const version = await moving(ctx, s);
    const at = (sec: number) => new Date(clock.base + sec * 1000).toISOString();
    const point = (dLat: number, sec: number) => ({
      lat: ORIGIN.lat + dLat,
      lng: ORIGIN.lng,
      speedKmh: 40,
      recordedAt: at(sec),
    });
    const outliers = async () =>
      (
        await ctx.pool.query(
          `SELECT (lat::float8 - $2)::numeric(9,4)::float8 AS d FROM location_point
            WHERE transport_id = $1 AND outlier ORDER BY recorded_at`,
          [s.transportId, ORIGIN.lat],
        )
      ).rows.map((r) => r.d);
    const nearCount = async () =>
      (await eventNames(ctx.pool, 0)).filter((e) => e.name === 'incoming.near').length;

    // 인수 기준: 입구(0.02도) 800m 전을 가다가 1초 뒤 입구 50m 지점이 찍힘(초속 약 750m) → 판정에 쓰지 않는다
    await locations(ctx, s, { deviceId: 'device-kim01', points: [point(0.0128, 0)] });
    await locations(ctx, s, { deviceId: 'device-kim01', points: [point(0.01955, 1)] });
    assert.deepEqual(await outliers(), [0.0196]);
    assert.equal(await nearCount(), 0);
    // 그다음 정상 좌표는 튄 좌표가 아니라 직전 정상 좌표(800m 전)와 비교한다 → 정상
    await locations(ctx, s, { deviceId: 'device-kim01', points: [point(0.0129, 6)] });
    assert.deepEqual(await outliers(), [0.0196]);

    // 끊겼다 붙어서 늦게 온 좌표: 튄 좌표 앞에 끼어도 판정을 다시 해 결과가 맞다
    await locations(ctx, s, { deviceId: 'device-kim01', points: [point(0.01285, 0.5)] });
    assert.deepEqual(await outliers(), [0.0196]);

    // 실제로 입구에 다가오면(초속 60m 이하) 알림이 간다
    await locations(ctx, s, { deviceId: 'device-kim01', points: [point(0.0198, 30)] });
    assert.equal(await nearCount(), 1);

    // 이동 거리에도 튄 좌표는 넣지 않는다: 0.0128 → 0.01285 → 0.0129 → 0.0198 = 0.007도 ≈ 778m
    const arrived = await post(ctx, s.kim, `/transports/${s.transportId}/arrive`, {
      method: 'button',
      version,
    });
    assert.equal(arrived.status, 200);
    const { rows } = await ctx.pool.query('SELECT points FROM anonymous_route');
    assert.equal(rows[0].points.length, 4);
    const after = await counts(ctx.pool, s.transportId);
    assert.ok(Math.abs(after.distance_m - (0.0198 - 0.0128) * 111_195) < 5, `${after.distance_m}`);
    assert.equal(after.points, 0);
  });
});
