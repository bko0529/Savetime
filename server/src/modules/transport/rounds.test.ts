// SFR-131 반경 넓혀 다시 요청 · SFR-128 승인 취소 뒤 다시 요청 · SFR-163 요청 대상 미리보기를 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, ORIGIN, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';

function post(ctx: AuthContext, token: string, path: string, body: object) {
  return request(appFor(ctx))
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}
const rounds = (ctx: AuthContext, s: Scene, body: object, token = s.kim) =>
  post(ctx, token, `/transports/${s.transportId}/rounds`, body);

// 알림 켠 PC가 있는 병원 (요청 대상). dLat 0.01 ≈ 1.1km
async function addHospital(pool: pg.Pool, name: string, dLat: number, grade = 3): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, account_active, grade) VALUES ($1, $1, $2, $3, true, $4) RETURNING id`,
    [name, ORIGIN.lat + dLat, ORIGIN.lng, grade],
  );
  const { rows: pc } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, '접수대', $2) RETURNING id`,
    [rows[0].id, randomUUID()],
  );
  await pool.query(
    `INSERT INTO hospital_shift (pc_id, staff_name, alarm_on_at) VALUES ($1, '박서연', now())`,
    [pc[0].id],
  );
  return Number(rows[0].id);
}

// 2분이 지나 모두 만료돼 예비 추천이 된 상태
async function toFallback(pool: pg.Pool, s: Scene): Promise<void> {
  await pool.query(`UPDATE hospital_request SET status = 'expired' WHERE id = ANY($1::bigint[])`, [
    Object.values(s.req),
  ]);
  await pool.query(
    `UPDATE transport SET status = 'fallback', fallback_reason = 'expired_no_approval' WHERE id = $1`,
    [s.transportId],
  );
}

// 회차별로 요청이 간 병원 이름
async function roundTargets(pool: pg.Pool, transportId: string) {
  const { rows } = await pool.query(
    `SELECT r.round_no, r.kind, r.radius_km, array_agg(h.name ORDER BY h.name) AS names
       FROM request_round r JOIN hospital_request hr ON hr.round_id = r.id JOIN hospital h ON h.id = hr.hospital_id
      WHERE r.transport_id = $1 GROUP BY r.id ORDER BY r.round_no`,
    [transportId],
  );
  return rows.map((r) => [r.round_no, r.kind, r.radius_km, r.names]);
}

async function lastSeq(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query('SELECT coalesce(max(seq), 0)::int AS n FROM event_log');
  return rows[0].n;
}

test('반경을 넓히면 넓힌 반경 안의 아직 요청 안 한 병원에만 새 회차가 간다 (SFR-131, A12)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await addHospital(ctx.pool, 'F병원', 0.23); // 약 25km
    await addHospital(ctx.pool, 'G병원', 0.4); // 약 44km, 30km 밖
    await toFallback(ctx.pool, s);
    const since = await lastSeq(ctx.pool);

    const res = await rounds(ctx, s, { kind: 'expand', radiusKm: 30, version: 1 });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'requesting');
    assert.equal(res.body.requestRadiusKm, 30);
    assert.equal(res.body.version, 2);

    // B·C·D는 1회차에 이미 요청했으니 다시 가지 않는다
    assert.deepEqual(await roundTargets(ctx.pool, s.transportId), [
      [1, 'first', 20, ['B병원', 'C병원', 'D병원']],
      [2, 'expand', 30, ['F병원']],
    ]);
    const { rows: events } = await ctx.pool.query(
      'SELECT name, payload FROM event_log WHERE seq > $1 ORDER BY seq',
      [since],
    );
    assert.deepEqual(
      events.map((e) => e.name),
      ['transport.status', 'round.started'],
    );
    assert.equal(events[0].payload.event, 'EXPAND_ROUND');
    assert.deepEqual(
      [events[1].payload.roundNo, events[1].payload.kind, events[1].payload.targetCount],
      [2, 'expand', 1],
    );
  });
});

test('반경 넓히기: 한 단계만 · 새 대상 0곳이면 422로 예비 추천에 머문다 · 요청 중에는 불가', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);

    // 요청 중에는 반경 넓히기가 표에 없다
    const requesting = await rounds(ctx, s, { kind: 'expand', radiusKm: 30, version: 1 });
    assert.equal(requesting.status, 409);
    assert.equal(requesting.body.error.code, 'INVALID_TRANSITION');

    await toFallback(ctx.pool, s);
    const twoSteps = await rounds(ctx, s, { kind: 'expand', radiusKm: 40, version: 1 });
    assert.equal(twoSteps.status, 409);
    assert.equal(twoSteps.body.error.code, 'MAX_RADIUS');

    // 30km 안에 새 병원이 없다 (제외 병원 F만 있음)
    const f = await addHospital(ctx.pool, 'F병원', 0.23);
    await ctx.pool.query(
      `INSERT INTO excluded_hospital (transport_id, hospital_id, reason) VALUES ($1, $2, 'rejected')`,
      [s.transportId, f],
    );
    const none = await rounds(ctx, s, { kind: 'expand', radiusKm: 30, version: 1 });
    assert.equal(none.status, 422);
    assert.equal(none.body.error.code, 'NO_REQUEST_TARGET');
    assert.equal(none.body.error.details.current.status, 'fallback');
    assert.equal((await roundTargets(ctx.pool, s.transportId)).length, 1);

    // 버전 검사는 상태 조건(대상 수) 다음이라, 새 대상이 있을 때 확인한다 (stateMachine.ts 규칙 2)
    await addHospital(ctx.pool, 'H병원', 0.24);
    const noVersion = await rounds(ctx, s, { kind: 'expand', radiusKm: 30 });
    assert.equal(noVersion.status, 400);
    assert.equal(noVersion.body.error.code, 'VERSION_REQUIRED');
  });
});

test('반경 넓히기는 고른 병원 등급을 그대로 쓴다 (SFR-162)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await addHospital(ctx.pool, 'F병원', 0.23, 3);
    await addHospital(ctx.pool, 'G병원', 0.24, 1);
    await toFallback(ctx.pool, s);
    await ctx.pool.query('UPDATE transport SET requested_grade = 1 WHERE id = $1', [s.transportId]);

    const res = await rounds(ctx, s, { kind: 'expand', radiusKm: 30, version: 1 });
    assert.equal(res.status, 201);
    assert.deepEqual((await roundTargets(ctx.pool, s.transportId))[1], [2, 'expand', 30, ['G병원']]);
  });
});

// B병원으로 확정해 이동 중으로 만든 뒤, B병원이 승인을 취소한 상태 (병원 웹 승인 취소와 같은 결과를 DB에 만든다)
async function confirmThenCancel(ctx: AuthContext, s: Scene, name: string, version: number) {
  const confirmed = await post(ctx, s.kim, `/transports/${s.transportId}/confirm`, {
    hospitalRequestId: s.req[name],
    version,
  }).set('Idempotency-Key', randomUUID());
  assert.equal(confirmed.status, 200);
  await ctx.pool.query(
    `UPDATE hospital_request SET status = 'closed', closed_reason = 'approval_cancelled', reason = 'er_bed'
      WHERE id = $1`,
    [s.req[name]],
  );
  await ctx.pool.query(
    `INSERT INTO excluded_hospital (transport_id, hospital_id, reason)
     SELECT $1, hospital_id, 'approval_cancelled' FROM hospital_request WHERE id = $2`,
    [s.transportId, s.req[name]],
  );
  return confirmed.body.version as number;
}

test('확정 병원이 승인을 취소하면 다시 요청: 그 병원만 빼고 지금 반경 안 병원에 새 회차 (SFR-128, A20)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);

    // 승인 취소 전에는 다시 요청할 수 없다
    const moving = await post(ctx, s.kim, `/transports/${s.transportId}/confirm`, {
      hospitalRequestId: s.req['B병원'],
      version: 1,
    }).set('Idempotency-Key', randomUUID());
    const early = await rounds(ctx, s, { kind: 're_request', version: moving.body.version });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'RE_REQUEST_NOT_ALLOWED');

    await ctx.pool.query(
      `UPDATE hospital_request SET status = 'closed', closed_reason = 'approval_cancelled' WHERE id = $1`,
      [s.req['B병원']],
    );
    await ctx.pool.query(
      `INSERT INTO excluded_hospital (transport_id, hospital_id, reason)
       SELECT $1, hospital_id, 'approval_cancelled' FROM hospital_request WHERE id = $2`,
      [s.transportId, s.req['B병원']],
    );

    // 지금 위치(조금 이동함) 기준. 1회차에 요청했던 C·D에도 다시 간다 (제외 병원만 뺌)
    const res = await rounds(
      ctx,
      s,
      { kind: 're_request', version: moving.body.version, location: { lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng } },
      s.lee,
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'requesting');
    assert.deepEqual((await roundTargets(ctx.pool, s.transportId))[1], [
      2,
      're_request',
      20,
      ['C병원', 'D병원'],
    ]);
    // 경로 안내 중이던 출발 시각은 그대로 (SFR-036)
    const { rows } = await ctx.pool.query(
      'SELECT departed_at IS NOT NULL AS departed, dest_changed_at FROM transport WHERE id = $1',
      [s.transportId],
    );
    assert.deepEqual(rows[0], { departed: true, dest_changed_at: null });
  });
});

test('다시 요청해 간 병원도 승인을 취소하면 또 다시 요청할 수 있다 (SFR-128 인수 기준 5)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    let version = await confirmThenCancel(ctx, s, 'B병원', 1);
    const first = await rounds(ctx, s, { kind: 're_request', version });
    assert.equal(first.status, 201);

    // 2회차에서 C병원이 승인 → 확정 → 승인 취소
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
    version = await confirmThenCancel(ctx, s, 'C병원', first.body.version);

    const second = await rounds(ctx, s, { kind: 're_request', version });
    assert.equal(second.status, 201);
    assert.deepEqual((await roundTargets(ctx.pool, s.transportId))[2], [3, 're_request', 20, ['D병원']]);
  });
});

test('요청 대상 미리보기: 지금 조건의 수, 등급마다 고르면 몇 곳인지 (SFR-163)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await ctx.pool.query(`UPDATE hospital SET grade = 1 WHERE name = 'B병원'`);
    await ctx.pool.query(`UPDATE hospital SET grade = 2 WHERE name = 'C병원'`);
    const get = (query: Record<string, string | number>) =>
      request(appFor(ctx))
        .get('/api/v1/request-targets/preview')
        .query(query)
        .set('Authorization', `Bearer ${s.kim}`);

    // 이송 생성이 실제로 요청한 수(3곳)와 같다
    const all = await get({ lat: ORIGIN.lat, lng: ORIGIN.lng, radiusKm: 20 });
    assert.equal(all.status, 200);
    assert.equal(all.body.count, Object.keys(s.req).length);
    assert.deepEqual(all.body.byGrade, { '1': 1, '2': 2, '3': 3 });
    assert.ok(!Number.isNaN(Date.parse(all.body.serverNow)));

    const university = await get({ lat: ORIGIN.lat, lng: ORIGIN.lng, radiusKm: 20, grade: 1 });
    assert.equal(university.body.count, 1);

    // 반경 10km면 B·C·D 모두 안(2~7km)이라 같다. 알림을 끈 병원은 빠진다
    await ctx.pool.query(
      `UPDATE hospital_shift SET alarm_on_at = NULL
        WHERE pc_id IN (SELECT p.id FROM hospital_pc p JOIN hospital h ON h.id = p.hospital_id WHERE h.name = 'D병원')`,
    );
    const ten = await get({ lat: ORIGIN.lat, lng: ORIGIN.lng, radiusKm: 10 });
    assert.equal(ten.body.count, 2);

    const badRadius = await get({ lat: ORIGIN.lat, lng: ORIGIN.lng, radiusKm: 15 });
    assert.equal(badRadius.status, 400);
    const outside = await get({ lat: 35.0, lng: 140.0, radiusKm: 20 });
    assert.equal(outside.status, 400);
    const anonymous = await request(appFor(ctx))
      .get('/api/v1/request-targets/preview')
      .query({ lat: ORIGIN.lat, lng: ORIGIN.lng, radiusKm: 20 });
    assert.equal(anonymous.status, 401);
  });
});
