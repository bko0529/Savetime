// SFR-076 이송 취소 · SFR-080 수동 도착을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, login, requestStates, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';

function post(ctx: AuthContext, token: string, path: string, body: object = {}) {
  return request(appFor(ctx))
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

const cancel = (ctx: AuthContext, token: string, id: string, body: object) =>
  post(ctx, token, `/transports/${id}/cancel`, body);
const arrive = (ctx: AuthContext, token: string, id: string, body: object) =>
  post(ctx, token, `/transports/${id}/arrive`, body);

// B병원으로 확정해 '이동 중'으로 만든다 (확정 API를 그대로 탄다)
async function moving(ctx: AuthContext, s: Scene): Promise<void> {
  const res = await post(ctx, s.kim, `/transports/${s.transportId}/confirm`, {
    hospitalRequestId: s.req['B병원'],
    version: 1,
  }).set('Idempotency-Key', randomUUID());
  assert.equal(res.status, 200);
}

async function events(pool: pg.Pool, since = 0) {
  const { rows } = await pool.query(
    'SELECT room, name, payload FROM event_log WHERE seq > $1 ORDER BY seq',
    [since],
  );
  return rows;
}

async function lastSeq(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query('SELECT coalesce(max(seq), 0)::int AS n FROM event_log');
  return rows[0].n;
}

async function origin(pool: pg.Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT origin_lat IS NULL AND origin_lng IS NULL AND address IS NULL AS cleared
       FROM transport WHERE id = $1`,
    [id],
  );
  return rows[0].cleared;
}

test('요청 중에 취소하면 모든 병원 요청이 이송 취소로 닫히고, 병원 웹과 팀원에게 알린다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    // 위치 미동의 때처럼 현장 주소가 있는 건 (SFR-009). 끝나면 출발 좌표와 같이 지워져야 한다 (SER-012)
    await ctx.pool.query(
      "UPDATE transport SET address = '천안시 동남구 신부동 123-4' WHERE id = $1",
      [s.transportId],
    );
    assert.equal(await origin(ctx.pool, s.transportId), false);
    const since = await lastSeq(ctx.pool);

    const res = await cancel(ctx, s.lee, s.transportId, { version: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'cancelled');
    assert.equal(res.body.version, 2);
    assert.deepEqual(await requestStates(ctx.pool), [
      ['B병원', 'closed', 'cancelled'],
      ['C병원', 'closed', 'cancelled'],
      ['D병원', 'closed', 'cancelled'],
    ]);
    // 이송이 끝나면 출발 좌표·현장 주소 원본을 지운다 (SER-002·012)
    assert.equal(await origin(ctx.pool, s.transportId), true);

    const sent = await events(ctx.pool, since);
    assert.deepEqual(
      sent.map((e) => e.name),
      ['request.changed', 'request.changed', 'request.changed', 'transport.status'],
    );
    assert.equal(sent[0].payload.closeReason, 'cancelled');
    assert.deepEqual(
      { ...sent[3].payload, transportId: undefined },
      {
        transportId: undefined,
        status: 'cancelled',
        event: 'CANCEL',
        reason: 'user',
        byName: '김도윤',
      },
    );
  });
});

test('이동 중에 취소하면 확정 병원 요청도 닫히고 도착 예정 목록에서 빠진다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await moving(ctx, s);
    const since = await lastSeq(ctx.pool);
    const res = await cancel(ctx, s.kim, s.transportId, { version: 2 });
    assert.equal(res.body.status, 'cancelled');
    assert.deepEqual((await requestStates(ctx.pool))[0], ['B병원', 'closed', 'cancelled']);
    const sent = await events(ctx.pool, since);
    assert.deepEqual(
      sent.map((e) => e.name),
      ['request.changed', 'incoming.removed', 'transport.status'],
    );
    assert.deepEqual(sent[1].payload, { requestId: s.req['B병원'], reason: 'cancelled' });
  });
});

test('예비 추천·전화 확인에서도 취소된다 (진행 중 4상태 모두)', async () => {
  for (const status of ['fallback', 'phone_check']) {
    await withAuthContext(async (ctx) => {
      const s = await scene(ctx);
      await ctx.pool.query(`UPDATE transport SET status = $2 WHERE id = $1`, [
        s.transportId,
        status,
      ]);
      const res = await cancel(ctx, s.kim, s.transportId, { version: 1 });
      assert.equal(res.body.status, 'cancelled', status);
    });
  }
});

test('이미 끝난 건·옛 버전·버전 없음·남의 건은 취소하지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const stale = await cancel(ctx, s.kim, s.transportId, { version: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal(stale.body.error.details.current.status, 'requesting');
    const noVersion = await cancel(ctx, s.kim, s.transportId, {});
    assert.equal(noVersion.status, 400);
    assert.equal(noVersion.body.error.code, 'VERSION_REQUIRED');

    const other = await login(ctx, 'park01');
    await post(ctx, other, '/teams', { role: 'driver' });
    assert.equal((await cancel(ctx, other, s.transportId, { version: 1 })).status, 404);
    assert.equal((await cancel(ctx, s.kim, 'not-a-uuid', { version: 1 })).status, 404);

    assert.equal((await cancel(ctx, s.kim, s.transportId, { version: 1 })).status, 200);
    const again = await cancel(ctx, s.kim, s.transportId, { version: 2 });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INVALID_TRANSITION');
    assert.equal(again.body.error.details.current.status, 'cancelled');
  });
});

test('이동 중에 도착을 누르면 끝나고, 확정 병원 요청도 도착 처리되며 걸린 시간을 돌려준다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await moving(ctx, s);
    const since = await lastSeq(ctx.pool);

    const res = await arrive(ctx, s.lee, s.transportId, { method: 'menu', version: 2 });
    assert.equal(res.status, 200);
    assert.ok(res.body.arrivedAt);
    assert.ok(res.body.departedAt);
    assert.equal(typeof res.body.durationSec, 'number');
    assert.ok(res.body.durationSec >= 0);
    // 이동 거리는 위치 기록(S5)이 생기면 채운다
    assert.equal(res.body.distanceKm, null);

    const { rows } = await ctx.pool.query(
      `SELECT t.status, t.arrival_method, t.version, t.origin_lat IS NULL AS cleared,
              hr.status AS request, hr.arrived_at IS NOT NULL AS request_arrived
         FROM transport t JOIN hospital_request hr ON hr.id = $2 WHERE t.id = $1`,
      [s.transportId, s.req['B병원']],
    );
    assert.deepEqual(rows[0], {
      status: 'arrived',
      arrival_method: 'menu',
      version: 3,
      cleared: true,
      request: 'arrived',
      request_arrived: true,
    });
    const { rows: history } = await ctx.pool.query(
      'SELECT event, reason FROM transport_status_history WHERE transport_id = $1 ORDER BY id',
      [s.transportId],
    );
    assert.deepEqual(history.at(-1), { event: 'ARRIVE', reason: 'menu' });

    const sent = await events(ctx.pool, since);
    assert.deepEqual(
      sent.map((e) => e.name),
      ['request.changed', 'incoming.arrived', 'transport.arrived'],
    );
    assert.equal(sent[1].payload.method, 'menu');
    assert.equal(sent[2].payload.durationSec, res.body.durationSec);
  });
});

test('이동 중이 아니거나 옛 버전이면 도착 처리하지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const early = await arrive(ctx, s.kim, s.transportId, { method: 'menu', version: 1 });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'INVALID_TRANSITION');
    assert.equal(early.body.error.details.current.status, 'requesting');

    await moving(ctx, s);
    const stale = await arrive(ctx, s.kim, s.transportId, { method: 'button', version: 1 });
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal(
      (await arrive(ctx, s.kim, s.transportId, { method: 'walk', version: 2 })).status,
      400,
    );
    assert.equal(
      (await arrive(ctx, s.kim, s.transportId, { method: 'button', version: 2 })).status,
      200,
    );
  });
});

test('마지막 1명이 근무를 끝내 이송이 취소되면 병원 웹에도 이송 취소 이벤트가 남는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await post(ctx, s.lee, '/teams/current/leave?confirmCancelActive=true');
    const since = await lastSeq(ctx.pool);
    const res = await post(ctx, s.kim, '/auth/logout?confirmCancelActive=true');
    assert.equal(res.status, 204);

    const sent = await events(ctx.pool, since);
    assert.equal(sent.filter((e) => e.name === 'request.changed').length, 3);
    const status = sent.find((e) => e.name === 'transport.status')!;
    assert.equal(status.payload.reason, 'logout');
    assert.equal(status.payload.byName, null);
    assert.equal(await origin(ctx.pool, s.transportId), true);
  });
});

// SFR-126: 첫 회차 요청 시각부터 첫 승인·출발까지. 이송 건·계정과 연결하지 않는 익명 1줄
async function stats(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT h.name AS hospital, s.request_to_approve_sec AS approve, s.request_to_depart_sec AS depart,
            s.departed_at IS NOT NULL AS departed, s.arrived_at IS NOT NULL AS arrived, s.duration_sec
       FROM transport_stat s LEFT JOIN hospital h ON h.id = s.hospital_id ORDER BY s.id`,
  );
  return rows;
}

test('도착하면 소요시간 통계가 1줄: 요청 → 첫 승인 40초, 요청 → 출발 70초 (SFR-126)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await moving(ctx, s);
    // 시계를 맞춘다: 출발 = 요청 + 70초, B 승인 = 요청 + 40초, C 승인 = 요청 + 55초 (첫 승인은 B)
    await ctx.pool.query(
      `UPDATE request_round r SET sent_at = t.departed_at - interval '70 seconds'
         FROM transport t WHERE t.id = r.transport_id AND t.id = $1`,
      [s.transportId],
    );
    await ctx.pool.query(
      `UPDATE hospital_request hr
          SET responded_at = r.sent_at + CASE WHEN hr.id = $1 THEN interval '40 seconds' ELSE interval '55 seconds' END
         FROM request_round r WHERE r.id = hr.round_id AND hr.id = ANY($2::bigint[])`,
      [s.req['B병원'], [s.req['B병원'], s.req['C병원']]],
    );
    // 이송 건 칸이 없어서 통계로는 어느 이송인지 알 수 없다
    const { rows: cols } = await ctx.pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'transport_stat'`,
    );
    assert.ok(!cols.some((c) => /transport_id|paramedic|team/.test(c.column_name)));

    assert.equal(
      (await arrive(ctx, s.lee, s.transportId, { method: 'menu', version: 2 })).status,
      200,
    );
    const [row, ...rest] = await stats(ctx.pool);
    assert.equal(rest.length, 0);
    assert.equal(row.hospital, 'B병원');
    assert.equal(row.approve, 40);
    assert.equal(row.depart, 70);
    assert.equal(row.departed, true);
    assert.equal(row.arrived, true);
    assert.ok(row.duration_sec >= 0);
  });
});

test('요청 중에 취소해도 통계 1줄: 출발·도착·병원은 비고, 실패한 취소는 남기지 않는다 (SFR-126)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    // 옛 버전 취소는 롤백 → 통계도 없다
    assert.equal((await cancel(ctx, s.kim, s.transportId, { version: 9 })).status, 409);
    assert.equal((await stats(ctx.pool)).length, 0);

    assert.equal((await cancel(ctx, s.kim, s.transportId, { version: 1 })).status, 200);
    const rows = await stats(ctx.pool);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hospital, null);
    assert.equal(rows[0].depart, null);
    assert.equal(rows[0].arrived, false);
    // scene 이 B·C 를 승인해 둬서 첫 승인 시간은 남는다
    assert.equal(typeof rows[0].approve, 'number');
  });
});

test('끝난 이송의 출발 위치는 통계에 약 100m 격자로만 남고, 원본 좌표·현장 주소는 지운다 (SER-012)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await ctx.pool.query(
      `UPDATE transport SET origin_lat = 36.81549, origin_lng = 127.11391,
              address = '천안시 동남구 신부동 123-4' WHERE id = $1`,
      [s.transportId],
    );
    assert.equal((await cancel(ctx, s.lee, s.transportId, { version: 1 })).status, 200);

    assert.equal(await origin(ctx.pool, s.transportId), true);
    const { rows } = await ctx.pool.query(
      'SELECT origin_grid_lat::float8 AS lat, origin_grid_lng::float8 AS lng FROM transport_stat',
    );
    assert.deepEqual(rows, [{ lat: 36.815, lng: 127.114 }]);
    // 주소 글은 통계 어디에도 없다
    const { rows: dump } = await ctx.pool.query(
      'SELECT row_to_json(s)::text AS j FROM transport_stat s',
    );
    assert.doesNotMatch(dump[0].j, /신부동|천안/);
  });
});
