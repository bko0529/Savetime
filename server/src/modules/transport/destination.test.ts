// SFR-077 목적지 변경 인수 기준(이전 목적지 병원 웹에 알림, 그 병원을 뺀 반경 안 병원에 새 요청, 1번만)을 임시 DB로 확인한다.
// '길게 누르기'는 앱 화면 몫이라 여기서는 서버가 받는 API만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, login, ORIGIN, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';

function post(ctx: AuthContext, token: string, path: string, body: object) {
  return request(appFor(ctx))
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}
const change = (ctx: AuthContext, s: Scene, body: object, token = s.kim) =>
  post(ctx, token, `/transports/${s.transportId}/destination`, body);

// B병원으로 확정해 '이동 중'으로 만든다. 돌려받은 version 으로 다음 요청을 보낸다
async function movingTo(ctx: AuthContext, s: Scene, name: string, version: number) {
  const res = await post(ctx, s.kim, `/transports/${s.transportId}/confirm`, {
    hospitalRequestId: s.req[name],
    version,
  }).set('Idempotency-Key', randomUUID());
  assert.equal(res.status, 200);
  return res.body.version as number;
}

async function roundTargets(pool: pg.Pool, transportId: string) {
  const { rows } = await pool.query(
    `SELECT r.round_no, r.kind, array_agg(h.name ORDER BY h.name) AS names
       FROM request_round r JOIN hospital_request hr ON hr.round_id = r.id JOIN hospital h ON h.id = hr.hospital_id
      WHERE r.transport_id = $1 GROUP BY r.id ORDER BY r.round_no`,
    [transportId],
  );
  return rows.map((r) => [r.round_no, r.kind, r.names]);
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

async function hospitalId(pool: pg.Pool, name: string): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM hospital WHERE name = $1', [name]);
  return rows[0].id;
}

test('목적지 변경: 이전 목적지는 닫힘·제외, 그 병원을 뺀 지금 위치 반경 안 병원에 새 요청 (SFR-077 인수 기준 2)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const version = await movingTo(ctx, s, 'B병원', 1);
    const { rows: before } = await ctx.pool.query(
      'SELECT departed_at, nav_device_id FROM transport WHERE id = $1',
      [s.transportId],
    );
    const since = await lastSeq(ctx.pool);
    const b = await hospitalId(ctx.pool, 'B병원');

    const res = await change(
      ctx,
      s,
      { reason: 'patient_change', version, location: { lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng } },
      s.lee,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'requesting');
    assert.equal(res.body.version, version + 1);
    assert.equal(res.body.destinationChangeUsed, true);

    // 새 회차는 B를 뺀 C·D (1회차에 요청했던 병원도 다시 간다)
    assert.deepEqual(await roundTargets(ctx.pool, s.transportId), [
      [1, 'first', ['B병원', 'C병원', 'D병원']],
      [2, 'dest_change', ['C병원', 'D병원']],
    ]);
    const { rows: bReq } = await ctx.pool.query(
      'SELECT status, closed_reason FROM hospital_request WHERE id = $1',
      [s.req['B병원']],
    );
    assert.deepEqual(bReq[0], { status: 'closed', closed_reason: 'dest_changed' });
    const { rows: excluded } = await ctx.pool.query(
      'SELECT hospital_id, reason FROM excluded_hospital WHERE transport_id = $1',
      [s.transportId],
    );
    assert.deepEqual(excluded, [{ hospital_id: b, reason: 'dest_changed' }]);

    // 이전 목적지·사유·시각 기록. 출발 시각·경로 안내 담당 단말은 그대로 (SFR-036·039)
    const { rows: after } = await ctx.pool.query(
      `SELECT dest_changed_at IS NOT NULL AS changed, dest_changed_from_hospital_id AS from_id,
              dest_change_reason AS reason, confirmed_hospital_id, departed_at, nav_device_id
         FROM transport WHERE id = $1`,
      [s.transportId],
    );
    assert.deepEqual(after[0], {
      changed: true,
      from_id: b,
      reason: 'patient_change',
      confirmed_hospital_id: null,
      departed_at: before[0].departed_at,
      nav_device_id: before[0].nav_device_id,
    });
    const { rows: history } = await ctx.pool.query(
      'SELECT event, reason FROM transport_status_history WHERE transport_id = $1 ORDER BY id DESC LIMIT 1',
      [s.transportId],
    );
    assert.deepEqual(history[0], { event: 'CHANGE_DESTINATION', reason: 'patient_change' });

    // B병원 웹: 행이 '목적지 변경'으로 닫히고 도착 예정에서 빠진다. 팀: 상태·새 회차. 환자 정보는 이벤트에 없다
    const sent = await eventsSince(ctx.pool, since);
    assert.deepEqual(
      sent.map((e) => [e.room, e.name]),
      [
        [`hospital:${b}`, 'request.changed'],
        [`hospital:${b}`, 'incoming.removed'],
        [sent[2].room, 'transport.status'],
        [sent[2].room, 'round.started'],
      ],
    );
    assert.match(sent[2].room, /^team:/);
    assert.equal(sent[0].payload.closeReason, 'dest_changed');
    assert.equal(sent[1].payload.reason, 'dest_changed');
    assert.equal(sent[3].payload.kind, 'dest_change');
    assert.equal(sent[3].payload.targetCount, 2);
    assert.doesNotMatch(JSON.stringify(sent), /두통/);
  });
});

test('목적지는 1번만: 두 번째는 409 DESTINATION_CHANGE_USED (SFR-077 인수 기준 3)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    let version = await movingTo(ctx, s, 'B병원', 1);
    const first = await change(ctx, s, { reason: 'road', version });
    assert.equal(first.status, 200);

    // 새 회차의 C병원 승인 → 확정 → 다시 이동 중
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
    version = await movingTo(ctx, s, 'C병원', first.body.version);

    const again = await change(ctx, s, { reason: 'hospital', version });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'DESTINATION_CHANGE_USED');
    assert.equal(again.body.error.details.current.status, 'moving');
    assert.equal((await roundTargets(ctx.pool, s.transportId)).length, 2);
  });
});

test('승인 취소 뒤 다시 요청은 목적지 변경 횟수에 세지 않는다 (SFR-128)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const version = await movingTo(ctx, s, 'B병원', 1);
    await ctx.pool.query(
      `UPDATE hospital_request SET status = 'closed', closed_reason = 'approval_cancelled' WHERE id = $1`,
      [s.req['B병원']],
    );
    // 실제 승인 취소(병원 웹)가 하듯 제외 병원에도 넣는다
    await ctx.pool.query(
      `INSERT INTO excluded_hospital (transport_id, hospital_id, reason)
       SELECT $1, hospital_id, 'approval_cancelled' FROM hospital_request WHERE id = $2`,
      [s.transportId, s.req['B병원']],
    );
    const again = await post(ctx, s.kim, `/transports/${s.transportId}/rounds`, {
      kind: 're_request',
      version,
    });
    assert.equal(again.status, 201);

    // 다시 요청한 회차의 C병원 승인 → 확정 → 목적지 변경은 아직 쓸 수 있다
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
    const moving = await movingTo(ctx, s, 'C병원', again.body.version);
    const res = await change(ctx, s, { reason: 'etc', version: moving });
    assert.equal(res.status, 200);
    assert.deepEqual((await roundTargets(ctx.pool, s.transportId))[2], [
      3,
      'dest_change',
      ['D병원'],
    ]);
  });
});

test('사유 없음 422 · 버전 없음 400 · 옛 버전 409 · 이동 중 아님 409 · 대상 0곳 422, 모두 아무것도 안 바뀐다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);

    // 요청 중(이동 전)에는 목적지 변경이 없다
    const early = await change(ctx, s, { reason: 'road', version: 1 });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'INVALID_TRANSITION');

    const version = await movingTo(ctx, s, 'B병원', 1);
    const noReason = await change(ctx, s, { version });
    assert.equal(noReason.status, 422);
    assert.equal(noReason.body.error.code, 'REASON_REQUIRED');
    const noVersion = await change(ctx, s, { reason: 'road' });
    assert.equal(noVersion.status, 400);
    assert.equal(noVersion.body.error.code, 'VERSION_REQUIRED');
    const stale = await change(ctx, s, { reason: 'road', version: version - 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    const badReason = await change(ctx, s, { reason: 'bored', version });
    assert.equal(badReason.status, 400);

    // 반경 안 다른 병원이 모두 요청을 잠시 중지 → 보낼 곳 0곳
    await ctx.pool.query(
      `UPDATE hospital SET requests_paused = true WHERE name IN ('C병원', 'D병원')`,
    );
    const none = await change(ctx, s, { reason: 'road', version });
    assert.equal(none.status, 422);
    assert.equal(none.body.error.code, 'NO_REQUEST_TARGET');

    const { rows } = await ctx.pool.query(
      `SELECT t.status, t.version, t.dest_changed_at, hr.status AS b_status,
              (SELECT count(*)::int FROM request_round WHERE transport_id = t.id) AS rounds,
              (SELECT count(*)::int FROM excluded_hospital WHERE transport_id = t.id) AS excluded
         FROM transport t JOIN hospital_request hr ON hr.id = $2 WHERE t.id = $1`,
      [s.transportId, s.req['B병원']],
    );
    assert.deepEqual(rows[0], {
      status: 'moving',
      version,
      dest_changed_at: null,
      b_status: 'confirmed',
      rounds: 1,
      excluded: 0,
    });

    // 남의 팀 대원은 이송 건이 있는지조차 모른다
    const other = await login(ctx, 'park01');
    await post(ctx, other, '/teams', { role: 'driver' });
    assert.equal((await change(ctx, s, { reason: 'road', version }, other)).status, 404);
  });
});

test("목적지 변경으로 보낸 새 요청에도 앞에서 승인했던 병원에 '직전 승인 · 재확인' (SFR-156)", async () => {
  await withAuthContext(async (ctx) => {
    // 1회차: B·C 승인, D 대기 → B 확정 → 목적지 변경
    const s = await scene(ctx);
    const version = await movingTo(ctx, s, 'B병원', 1);
    const res = await change(ctx, s, { reason: 'patient_change', version });
    assert.equal(res.status, 200);

    const { rows } = await ctx.pool.query(
      `SELECT h.name, hr.prev_approved_recheck AS recheck FROM hospital_request hr
         JOIN request_round r ON r.id = hr.round_id JOIN hospital h ON h.id = hr.hospital_id
        WHERE r.transport_id = $1 AND r.round_no = 2 ORDER BY h.name`,
      [s.transportId],
    );
    assert.deepEqual(rows, [
      { name: 'C병원', recheck: true },
      { name: 'D병원', recheck: false },
    ]);
  });
});
