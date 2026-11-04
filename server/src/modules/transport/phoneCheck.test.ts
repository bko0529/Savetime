// SFR-032 전화 확인 시작 · SFR-034 결과 기록 · SFR-074 거절 시 다음 후보 · SFR-075 결과 미선택을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, requestStates, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';

function post(ctx: AuthContext, token: string, path: string, body: object) {
  return request(appFor(ctx))
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}
const start = (ctx: AuthContext, s: Scene, body: object, token = s.kim) =>
  post(ctx, token, `/transports/${s.transportId}/phone-check/start`, body);
const result = (ctx: AuthContext, s: Scene, body: object, token = s.kim) =>
  post(ctx, token, `/transports/${s.transportId}/phone-checks`, body);

// 요청하지 않은 E병원 (전화로만 확인하는 병원)
async function addHospital(pool: pg.Pool, name: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, er_phone) VALUES ($1, $1, 36.9, 127.1, '041-000-0000') RETURNING id`,
    [name],
  );
  return Number(rows[0].id);
}

async function transportRow(pool: pg.Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT status, version, phone_target_hospital_id, confirmed_hospital_id, departed_at IS NOT NULL AS departed
       FROM transport WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function lastSeq(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query('SELECT coalesce(max(seq), 0)::int AS n FROM event_log');
  return rows[0].n;
}

async function eventsSince(pool: pg.Pool, since: number) {
  const { rows } = await pool.query(
    'SELECT room, name, payload FROM event_log WHERE seq > $1 ORDER BY seq',
    [since],
  );
  return rows;
}

// 예비 추천 상태로 만든다 (열린 요청 없음)
async function toFallback(pool: pg.Pool, s: Scene): Promise<void> {
  await pool.query(
    `UPDATE hospital_request SET status = 'expired' WHERE id = ANY($1::bigint[])`,
    [Object.values(s.req)],
  );
  await pool.query(
    `UPDATE transport SET status = 'fallback', fallback_reason = 'all_rejected' WHERE id = $1`,
    [s.transportId],
  );
}

test('예비 추천에서 전화 확인을 시작하면 phone_check가 되고 대상 병원이 기록된다 (SFR-032, A13)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await toFallback(ctx.pool, s);
    const e = await addHospital(ctx.pool, 'E병원');
    const since = await lastSeq(ctx.pool);

    const res = await start(ctx, s, { hospitalId: e, version: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'phone_check');
    assert.equal(res.body.phoneTarget.hospitalId, e);
    assert.equal(res.body.phoneTarget.erPhone, '041-000-0000');
    assert.equal(res.body.version, 2);

    const t = await transportRow(ctx.pool, s.transportId);
    assert.equal(t.status, 'phone_check');
    assert.equal(Number(t.phone_target_hospital_id), e);

    // 팀원 화면도 같은 병원으로 (transport.phone_target)
    const events = await eventsSince(ctx.pool, since);
    assert.deepEqual(
      events.map((x) => x.name),
      ['transport.status', 'transport.phone_target'],
    );
    assert.deepEqual(events[1].payload, { transportId: s.transportId, hospitalId: e, hospitalName: 'E병원' });
  });
});

test('요청 중에 전화 확인을 시작해도 병원 요청은 닫지 않는다 (D-127)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const e = await addHospital(ctx.pool, 'E병원');
    const before = await requestStates(ctx.pool);
    const res = await start(ctx, s, { hospitalId: e, version: 1 }, s.lee);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'phone_check');
    assert.deepEqual(await requestStates(ctx.pool), before);
  });
});

test('시작: 버전 없음 400 · 버전 다름 409 · 없는 병원 404 · 제외 병원 400', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const e = await addHospital(ctx.pool, 'E병원');

    const noVersion = await start(ctx, s, { hospitalId: e });
    assert.equal(noVersion.status, 400);
    assert.equal(noVersion.body.error.code, 'VERSION_REQUIRED');

    const stale = await start(ctx, s, { hospitalId: e, version: 9 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal(stale.body.error.details.current.status, 'requesting');

    const missing = await start(ctx, s, { hospitalId: 999999, version: 1 });
    assert.equal(missing.status, 404);

    await ctx.pool.query(
      `INSERT INTO excluded_hospital (transport_id, hospital_id, reason) VALUES ($1, $2, 'phone_rejected')`,
      [s.transportId, e],
    );
    const excluded = await start(ctx, s, { hospitalId: e, version: 1 });
    assert.equal(excluded.status, 400);
    assert.equal(excluded.body.error.code, 'VALIDATION_FAILED');

    assert.equal((await transportRow(ctx.pool, s.transportId)).status, 'requesting');
  });
});

test('수용 확정하면 이동 중이 되고 열려 있던 요청은 요청 종료로 닫힌다 (SFR-034, A14)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const e = await addHospital(ctx.pool, 'E병원');
    await start(ctx, s, { hospitalId: e, version: 1 });
    const since = await lastSeq(ctx.pool);

    const res = await result(ctx, s, { hospitalId: e, result: 'accepted', version: 2 });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'moving');

    const t = await transportRow(ctx.pool, s.transportId);
    assert.deepEqual(
      [t.status, t.version, t.phone_target_hospital_id, Number(t.confirmed_hospital_id), t.departed],
      ['moving', 3, null, e, true],
    );
    // B·C(승인), D(대기) → 닫힘(fallback)
    assert.deepEqual(await requestStates(ctx.pool), [
      ['B병원', 'closed', 'fallback'],
      ['C병원', 'closed', 'fallback'],
      ['D병원', 'closed', 'fallback'],
    ]);

    // 결과 기록: 결과·시각만, 대원 계정 연결 없음 (DAR-004)
    const { rows: checks } = await ctx.pool.query(
      'SELECT hospital_id, result, reason, created_at IS NOT NULL AS at FROM phone_check WHERE transport_id = $1',
      [s.transportId],
    );
    assert.deepEqual(checks, [{ hospital_id: String(e), result: 'accepted', reason: null, at: true }]);

    const events = await eventsSince(ctx.pool, since);
    assert.deepEqual(
      events.map((x) => x.name),
      ['request.changed', 'request.changed', 'request.changed', 'transport.status'],
    );
    assert.equal(events[0].payload.closeReason, 'fallback');
    assert.equal(events[3].payload.event, 'PHONE_ACCEPTED');
  });
});

test('연결 실패·확인 생략은 사유가 있어야 출발한다 (A15)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await toFallback(ctx.pool, s);
    const e = await addHospital(ctx.pool, 'E병원');
    await start(ctx, s, { hospitalId: e, version: 1 });

    const noReason = await result(ctx, s, { hospitalId: e, result: 'no_answer', version: 2 });
    assert.equal(noReason.status, 422);
    assert.equal(noReason.body.error.code, 'REASON_REQUIRED');

    const res = await result(ctx, s, {
      hospitalId: e,
      result: 'skipped',
      reason: 'etc',
      reasonText: '환자 상태 급변',
      version: 2,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'moving');

    const { rows } = await ctx.pool.query(
      'SELECT result, reason, reason_text FROM phone_check WHERE transport_id = $1',
      [s.transportId],
    );
    assert.deepEqual(rows, [{ result: 'skipped', reason: 'etc', reason_text: '환자 상태 급변' }]);
    const { rows: history } = await ctx.pool.query(
      `SELECT event, reason FROM transport_status_history WHERE transport_id = $1 AND event = 'PHONE_PROCEED'`,
      [s.transportId],
    );
    assert.deepEqual(history, [{ event: 'PHONE_PROCEED', reason: 'etc' }]);
  });
});

test('결과: 대상 병원이 다르거나, 같은 결과를 두 번 보내거나, 전화 확인 중이 아니면 거절한다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const e = await addHospital(ctx.pool, 'E병원');
    const f = await addHospital(ctx.pool, 'F병원');

    // 전화 확인 중이 아님 (요청 중)
    const notStarted = await result(ctx, s, { hospitalId: e, result: 'accepted', version: 1 });
    assert.equal(notStarted.status, 409);
    assert.equal(notStarted.body.error.code, 'INVALID_TRANSITION');

    await start(ctx, s, { hospitalId: e, version: 1 });
    const wrong = await result(ctx, s, { hospitalId: f, result: 'accepted', version: 2 });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'VALIDATION_FAILED');

    const unknown = await result(ctx, s, { hospitalId: e, result: 'maybe', version: 2 });
    assert.equal(unknown.status, 400);

    // 팀원 두 명이 같이 '수용 확정'을 눌러도 한 번만 기록된다 (버전)
    const first = await result(ctx, s, { hospitalId: e, result: 'accepted', version: 2 });
    const second = await result(ctx, s, { hospitalId: e, result: 'accepted', version: 2 }, s.lee);
    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM phone_check WHERE transport_id = $1',
      [s.transportId],
    );
    assert.equal(rows[0].n, 1);
  });
});

// B·C병원에 응급실 빈 병상을 넣어 추천 1·2순위로 만든다. D병원은 병상 정보가 없어 추천 카드에 안 나온다
async function withBeds(pool: pg.Pool): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM hospital WHERE name IN ('B병원', 'C병원', 'D병원')`,
  );
  const ids = Object.fromEntries(rows.map((r) => [r.name, Number(r.id)]));
  for (const name of ['B병원', 'C병원']) {
    await pool.query(
      `INSERT INTO bed_current (hospital_id, er_avail, er_total, source_time) VALUES ($1, 3, 10, now())`,
      [ids[name]],
    );
  }
  return ids;
}

async function excludedOf(pool: pg.Pool, transportId: string) {
  const { rows } = await pool.query(
    'SELECT hospital_id, reason FROM excluded_hospital WHERE transport_id = $1 ORDER BY hospital_id',
    [transportId],
  );
  return rows.map((r) => [Number(r.hospital_id), r.reason]);
}

test('거절하면 제외 병원에 넣고 다음 순위 병원으로 전화 확인을 이어 간다 (SFR-074, A16·A17)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const h = await withBeds(ctx.pool);
    await toFallback(ctx.pool, s);
    await start(ctx, s, { hospitalId: h['B병원'], version: 1 });
    const since = await lastSeq(ctx.pool);

    // 1순위 B 거절 → 2순위 C
    const first = await result(ctx, s, { hospitalId: h['B병원'], result: 'rejected', version: 2 });
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'phone_check');
    assert.equal(first.body.phoneTarget.hospitalId, h['C병원']);
    assert.deepEqual(await excludedOf(ctx.pool, s.transportId), [[h['B병원'], 'phone_rejected']]);
    const events = await eventsSince(ctx.pool, since);
    assert.deepEqual(
      events.map((x) => x.name),
      ['transport.status', 'transport.phone_target'],
    );
    assert.equal(events[0].payload.event, 'PHONE_REJECTED_NEXT');
    assert.equal(events[1].payload.hospitalId, h['C병원']);

    // 2순위 C도 거절 → 추천 후보가 없어 예비 추천 (D는 병상 정보 없음 묶음이라 다음 후보가 아님)
    const last = await result(ctx, s, { hospitalId: h['C병원'], result: 'rejected', version: 3 });
    assert.equal(last.status, 201);
    assert.equal(last.body.status, 'fallback');
    assert.equal(last.body.phoneTarget, null);
    const t = await ctx.pool.query('SELECT fallback_reason FROM transport WHERE id = $1', [s.transportId]);
    assert.equal(t.rows[0].fallback_reason, 'phone_rejected_last');

    // 추천 목록에서도 B·C가 빠지고 반경 넓히기 안내가 나온다 (SFR-029)
    const rec = await request(appFor(ctx))
      .get(`/api/v1/transports/${s.transportId}/recommendations`)
      .set('Authorization', `Bearer ${s.kim}`);
    assert.equal(rec.status, 200);
    assert.deepEqual(rec.body.items, []);
    assert.equal(rec.body.emptyGuide, 'expand_radius');

    // 병원 요청은 건드리지 않고, 결과는 두 번 다 기록된다
    const { rows } = await ctx.pool.query(
      'SELECT result FROM phone_check WHERE transport_id = $1 ORDER BY id',
      [s.transportId],
    );
    assert.deepEqual(rows.map((r) => r.result), ['rejected', 'rejected']);
  });
});

test('요청이 열린 채로 마지막 후보를 거절하면 요청 중으로 돌아간다 (A17, D-127)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const e = await addHospital(ctx.pool, 'E병원');
    await start(ctx, s, { hospitalId: e, version: 1 });
    const before = await requestStates(ctx.pool);

    const res = await result(ctx, s, { hospitalId: e, result: 'rejected', version: 2 });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'requesting');
    assert.deepEqual(await requestStates(ctx.pool), before);
    const t = await ctx.pool.query('SELECT fallback_reason FROM transport WHERE id = $1', [s.transportId]);
    assert.equal(t.rows[0].fallback_reason, null);
  });
});

test('결과를 고르지 않고 닫으면 예비 추천으로, 제외하지 않아 다시 고를 수 있다 (SFR-075, A18)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const h = await withBeds(ctx.pool);
    await toFallback(ctx.pool, s);
    await start(ctx, s, { hospitalId: h['B병원'], version: 1 });

    const res = await result(ctx, s, { hospitalId: h['B병원'], result: 'dismissed', version: 2 });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'fallback');
    assert.equal(res.body.phoneTarget, null);
    assert.deepEqual(await excludedOf(ctx.pool, s.transportId), []);
    const { rows: history } = await ctx.pool.query(
      `SELECT event, reason FROM transport_status_history WHERE transport_id = $1 ORDER BY id DESC LIMIT 1`,
      [s.transportId],
    );
    assert.deepEqual(history, [{ event: 'PHONE_DISMISSED', reason: 'phone_dismissed' }]);

    // 같은 병원을 다시 누르면 전화 확인 화면이 다시 열린다
    const again = await start(ctx, s, { hospitalId: h['B병원'], version: 3 });
    assert.equal(again.status, 200);
    assert.equal(again.body.status, 'phone_check');
  });
});

test('요청이 열린 채로 닫으면 요청 중으로 돌아간다 (A18)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const e = await addHospital(ctx.pool, 'E병원');
    await start(ctx, s, { hospitalId: e, version: 1 });
    const res = await result(ctx, s, { hospitalId: e, result: 'dismissed', version: 2 }, s.lee);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'requesting');
  });
});
