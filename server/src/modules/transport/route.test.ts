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
  const res = await post(ctx, s.kim, `/transports/${s.transportId}/confirm`, {
    hospitalRequestId: s.req['B병원'],
    version: 1,
  }).set('Idempotency-Key', randomUUID());
  assert.equal(res.status, 200);
  return res.body.version;
}

// 출발 위치에서 북쪽으로 dLat씩, 1초 간격 (0.01도 ≈ 1.1km)
function track(...dLats: number[]) {
  const start = Date.now();
  return dLats.map((d, i) => ({
    lat: ORIGIN.lat + d,
    lng: ORIGIN.lng,
    speedKmh: 40,
    recordedAt: new Date(start + i * 1000).toISOString(),
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
      points: [{ ...track(0, 0, 0.02)[2] }],
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
      points: [{ ...track(0, 0, 0.002)[2] }],
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
