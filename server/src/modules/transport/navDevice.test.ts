// SFR-132 운전 역할 단말 경로 안내 자동 시작 인수 기준을 임시 DB로 확인한다.
// 장면: 김도윤(운전, device-kim01)·이하준(처치, device-lee01) 한 팀, B·C 승인
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, login, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';
import { runNavFallback } from './navDevice.js';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function confirmBy(ctx: AuthContext, s: Scene, token: string, name = 'B병원', version = 1) {
  const res = await request(appFor(ctx))
    .post(`/api/v1/transports/${s.transportId}/confirm`)
    .set(auth(token))
    .set('Idempotency-Key', randomUUID())
    .send({ hospitalRequestId: s.req[name], version });
  assert.equal(res.status, 200);
  return res.body;
}

const claim = (ctx: AuthContext, s: Scene, token: string, body: object) =>
  request(appFor(ctx))
    .post(`/api/v1/transports/${s.transportId}/nav-device`)
    .set(auth(token))
    .send(body);

const locate = (ctx: AuthContext, s: Scene, token: string, deviceId: string) =>
  request(appFor(ctx))
    .post(`/api/v1/transports/${s.transportId}/locations`)
    .set(auth(token))
    .send({
      deviceId,
      points: [{ lat: 36.815, lng: 127.1139, speedKmh: 30, recordedAt: new Date().toISOString() }],
    });

// 장면 대원 이름: 김도윤(운전)·이하준(처치)
async function namedScene(ctx: AuthContext): Promise<Scene> {
  const s = await scene(ctx);
  await ctx.pool.query("UPDATE paramedic SET name = '김도윤' WHERE login_id = 'kim01'");
  await ctx.pool.query("UPDATE paramedic SET name = '이하준' WHERE login_id = 'lee01'");
  return s;
}

async function navOf(pool: pg.Pool, transportId: string) {
  const { rows } = await pool.query(
    'SELECT nav_device_id, nav_fallback_device_id, version FROM transport WHERE id = $1',
    [transportId],
  );
  return rows[0];
}

async function navEvents(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT name, payload FROM event_log WHERE name IN ('transport.confirmed', 'transport.nav_device') ORDER BY seq`,
  );
  return rows;
}

// 확정이 n초 전이었던 것으로 맞춘다
const confirmedAgo = (pool: pg.Pool, id: string, seconds: number) =>
  pool.query(
    `UPDATE transport SET confirmed_at = now() - make_interval(secs => $2) WHERE id = $1`,
    [id, seconds],
  );

test('이하준이 B병원 선택 → 김도윤(운전) 단말이 10초 안에 응답해 경로 안내, 이하준은 보기 전용 (SFR-132 인수 기준 1)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await namedScene(ctx);
    const body = await confirmBy(ctx, s, s.lee);
    // 운전 단말 응답을 기다린다: 아직 담당 없음, 넘길 단말은 확정한 이하준 단말
    assert.equal(body.navDeviceId, null);
    assert.deepEqual(await navOf(ctx.pool, s.transportId), {
      nav_device_id: null,
      nav_fallback_device_id: 'device-lee01',
      version: 2,
    });
    // 기다리는 동안은 누구도 위치를 기록하지 않는다
    assert.equal((await locate(ctx, s, s.lee, 'device-lee01')).status, 403);
    // 운전자가 아닌 대원은 가져갈 수 없다
    assert.equal(
      (await claim(ctx, s, s.lee, { deviceId: 'device-lee01', version: 2 })).status,
      403,
    );

    const res = await claim(ctx, s, s.kim, { deviceId: 'device-kim01', version: 2 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { navDeviceId: 'device-kim01', isMe: true });
    assert.deepEqual(await navOf(ctx.pool, s.transportId), {
      nav_device_id: 'device-kim01',
      nav_fallback_device_id: null,
      version: 3,
    });
    const events = await navEvents(ctx.pool);
    assert.equal(events[0].payload.navDeviceId, null);
    assert.deepEqual(events[1].payload, {
      transportId: s.transportId,
      navDeviceId: 'device-kim01',
      byName: '김도윤',
    });

    // 같은 단말이 다시 보내도 그대로. 이하준 단말은 보기 전용
    assert.equal(
      (await claim(ctx, s, s.kim, { deviceId: 'device-kim01', version: 3 })).body.isMe,
      true,
    );
    const viewer = await claim(ctx, s, s.lee, { deviceId: 'device-lee01', version: 3 });
    assert.equal(viewer.status, 409);
    assert.equal(viewer.body.error.code, 'NAV_DEVICE_ASSIGNED');
    assert.equal(viewer.body.error.details.navDeviceId, 'device-kim01');
    // 위치는 담당 단말만 (SFR-133 재실행 때도 같은 규칙)
    assert.equal((await locate(ctx, s, s.kim, 'device-kim01')).status, 204);
    assert.equal((await locate(ctx, s, s.lee, 'device-lee01')).status, 403);
    // 10초 작업이 늦게 돌아도 아무것도 바꾸지 않는다
    await confirmedAgo(ctx.pool, s.transportId, 11);
    assert.deepEqual(await runNavFallback(ctx.pool, s.transportId), []);
  });
});

test("팀에 '운전' 역할이 없으면 선택한 이하준 단말에서 바로 시작한다 (SFR-132 인수 기준 2)", async () => {
  await withAuthContext(async (ctx) => {
    const s = await namedScene(ctx);
    await ctx.pool.query(`UPDATE team_member SET role = 'care'`);
    const body = await confirmBy(ctx, s, s.lee);
    assert.equal(body.navDeviceId, 'device-lee01');
    const events = await navEvents(ctx.pool);
    assert.deepEqual(
      events.map((e) => [e.name, e.payload.navDeviceId]),
      [
        ['transport.confirmed', 'device-lee01'],
        ['transport.nav_device', 'device-lee01'],
      ],
    );
    assert.equal((await locate(ctx, s, s.lee, 'device-lee01')).status, 204);
  });
});

test('김도윤(운전) 폰이 꺼져 있으면 10초 뒤 이하준 단말로 넘기고, 늦게 온 운전 단말은 보기 전용 (SFR-132 인수 기준 3)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await namedScene(ctx);
    await confirmBy(ctx, s, s.lee);

    // 10초 전에 깨면 아무것도 안 하고 다시 시도하게 한다 (판정은 DB 시각)
    assert.equal(await runNavFallback(ctx.pool, s.transportId), 'not_due');

    await confirmedAgo(ctx.pool, s.transportId, 11);
    const sent = await runNavFallback(ctx.pool, s.transportId);
    assert.ok(Array.isArray(sent));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].name, 'transport.nav_device');
    assert.deepEqual(sent[0].payload, {
      transportId: s.transportId,
      navDeviceId: 'device-lee01',
      byName: '이하준',
    });
    assert.deepEqual(await navOf(ctx.pool, s.transportId), {
      nav_device_id: 'device-lee01',
      nav_fallback_device_id: null,
      version: 3,
    });

    const late = await claim(ctx, s, s.kim, { deviceId: 'device-kim01', version: 3 });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'NAV_DEVICE_ASSIGNED');
    assert.equal((await locate(ctx, s, s.lee, 'device-lee01')).status, 204);
  });
});

test('10초가 지나 작업보다 운전 단말이 먼저 와도 결과는 같다: 이하준 단말로 넘기고 운전 단말은 보기 전용', async () => {
  await withAuthContext(async (ctx) => {
    const s = await namedScene(ctx);
    await confirmBy(ctx, s, s.lee);
    await confirmedAgo(ctx.pool, s.transportId, 11);
    const late = await claim(ctx, s, s.kim, { deviceId: 'device-kim01', version: 2 });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'NAV_DEVICE_ASSIGNED');
    // 넘김은 커밋됐다 (409 는 커밋 뒤 알림)
    assert.equal((await navOf(ctx.pool, s.transportId)).nav_device_id, 'device-lee01');
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM event_log WHERE name = 'transport.nav_device'`,
    );
    assert.equal(rows[0].n, 1);
  });
});

test('운전자가 직접 확정하면 바로 담당. 남의 단말 ID·옛 버전·버전 없음·출발 전·다른 팀은 거절', async () => {
  await withAuthContext(async (ctx) => {
    const s = await namedScene(ctx);
    // 출발 전에는 담당 단말이 없다
    assert.equal(
      (await claim(ctx, s, s.kim, { deviceId: 'device-kim01', version: 1 })).status,
      409,
    );
    const body = await confirmBy(ctx, s, s.kim);
    assert.equal(body.navDeviceId, 'device-kim01');

    // 운전 단말 응답을 기다리는 장면에서 버전·단말 검사
    await ctx.pool.query(
      `UPDATE transport SET nav_device_id = NULL, nav_fallback_device_id = 'device-lee01' WHERE id = $1`,
      [s.transportId],
    );
    const spoof = await claim(ctx, s, s.kim, { deviceId: 'device-lee01', version: 2 });
    assert.equal(spoof.status, 400);
    const noVersion = await claim(ctx, s, s.kim, { deviceId: 'device-kim01' });
    assert.equal(noVersion.body.error.code, 'VERSION_REQUIRED');
    const stale = await claim(ctx, s, s.kim, { deviceId: 'device-kim01', version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

    const park = await login(ctx, 'park01');
    await request(appFor(ctx)).post('/api/v1/teams').set(auth(park)).send({ role: 'driver' });
    assert.equal(
      (await claim(ctx, s, park, { deviceId: 'device-park01', version: 2 })).status,
      404,
    );
  });
});

test('목적지 변경 뒤 다시 확정해도 경로 안내 담당 단말은 그대로 (SFR-077)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await namedScene(ctx);
    await confirmBy(ctx, s, s.kim);
    const changed = await request(appFor(ctx))
      .post(`/api/v1/transports/${s.transportId}/destination`)
      .set(auth(s.lee))
      .send({ reason: 'road', version: 2 });
    assert.equal(changed.status, 200);
    assert.equal((await navOf(ctx.pool, s.transportId)).nav_device_id, 'device-kim01');

    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT hr.id FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
         JOIN hospital h ON h.id = hr.hospital_id
        WHERE r.transport_id = $1 AND r.round_no = 2 AND h.name = 'C병원'`,
      [s.transportId],
    );
    await ctx.pool.query(
      `UPDATE hospital_request SET status = 'approved', responded_at = now(), delivered_at = now() WHERE id = $1`,
      [rows[0].id],
    );
    s.req['C병원'] = Number(rows[0].id);
    const again = await confirmBy(ctx, s, s.lee, 'C병원', changed.body.version);
    assert.equal(again.navDeviceId, 'device-kim01');
    assert.equal((await navOf(ctx.pool, s.transportId)).nav_fallback_device_id, null);
  });
});
