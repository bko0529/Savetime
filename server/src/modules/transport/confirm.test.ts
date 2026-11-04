// SFR-111 승인 병원 확정 · SFR-125 다른 병원 요청 닫기 · SFR-160 먼저 온 확정 하나만을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import type { AuthContext } from '../auth/session.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const ORIGIN = { lat: 36.815, lng: 127.1139 };

function appFor(ctx: AuthContext) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
}

async function login(ctx: AuthContext, loginId: string): Promise<string> {
  await addParamedic(ctx.pool, { loginId });
  const res = await request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  return res.body.tokens.accessToken;
}

async function addHospital(pool: pg.Pool, name: string, dLat: number): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, account_active) VALUES ($1, $1, $2, $3, true) RETURNING id`,
    [name, ORIGIN.lat + dLat, ORIGIN.lng],
  );
  const { rows: pc } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, '접수대', $2) RETURNING id`,
    [rows[0].id, randomUUID()],
  );
  await pool.query(
    `INSERT INTO hospital_shift (pc_id, staff_name, alarm_on_at) VALUES ($1, '박서연', now())`,
    [pc[0].id],
  );
}

interface Scene {
  kim: string;
  lee: string;
  transportId: string;
  // 병원 이름 → 병원 요청 id
  req: Record<string, number>;
}

// 김도윤·이하준 한 팀이 B·C·D병원에 요청했고, B·C는 승인, D는 대기 중
async function scene(ctx: AuthContext): Promise<Scene> {
  const kim = await login(ctx, 'kim01');
  const lee = await login(ctx, 'lee01');
  const team = await request(appFor(ctx))
    .post('/api/v1/teams')
    .set('Authorization', `Bearer ${kim}`)
    .send({ role: 'driver' });
  await request(appFor(ctx))
    .post('/api/v1/teams/join')
    .set('Authorization', `Bearer ${lee}`)
    .send({ code: team.body.code, role: 'care' });
  await addHospital(ctx.pool, 'B병원', 0.02);
  await addHospital(ctx.pool, 'C병원', 0.04);
  await addHospital(ctx.pool, 'D병원', 0.06);
  const created = await request(appFor(ctx))
    .post('/api/v1/transports')
    .set('Authorization', `Bearer ${kim}`)
    .send({
      id: randomUUID(),
      radiusKm: 20,
      location: ORIGIN,
      locationConsent: true,
      assessment: { chiefComplaint: '갑작스러운 두통' },
    });
  const req: Record<string, number> = {};
  for (const r of created.body.requests) req[r.hospitalName] = r.id;
  await ctx.pool.query(
    `UPDATE hospital_request SET status = 'approved', responded_at = now(), delivered_at = now()
      WHERE id = ANY($1::bigint[])`,
    [[req['B병원'], req['C병원']]],
  );
  return { kim, lee, transportId: created.body.id, req };
}

function confirm(
  ctx: AuthContext,
  token: string,
  transportId: string,
  body: object,
  key: string | null = randomUUID(),
) {
  const call = request(appFor(ctx))
    .post(`/api/v1/transports/${transportId}/confirm`)
    .set('Authorization', `Bearer ${token}`);
  return (key === null ? call : call.set('Idempotency-Key', key)).send(body);
}

async function requestStates(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT h.name, hr.status, hr.closed_reason FROM hospital_request hr
       JOIN hospital h ON h.id = hr.hospital_id ORDER BY h.name`,
  );
  return rows.map((r) => [r.name, r.status, r.closed_reason]);
}

test('승인 병원을 확정하면 이동 중이 되고, 나머지 승인·대기 병원 요청은 다른 병원으로 이송으로 닫힌다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const res = await confirm(ctx, s.lee, s.transportId, {
      hospitalRequestId: s.req['B병원'],
      version: 1,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'moving');
    assert.equal(res.body.version, 2);
    assert.equal(res.body.confirmedHospital.name, 'B병원');
    assert.equal(res.body.confirmedHospital.requestStatus, 'confirmed');
    assert.ok(res.body.departedAt);

    assert.deepEqual(await requestStates(ctx.pool), [
      ['B병원', 'confirmed', null],
      ['C병원', 'closed', 'other_hospital'],
      ['D병원', 'closed', 'other_hospital'],
    ]);
    const { rows: history } = await ctx.pool.query(
      `SELECT from_status, to_status, event FROM transport_status_history
        WHERE transport_id = $1 ORDER BY id`,
      [s.transportId],
    );
    assert.deepEqual(history.at(-1), {
      from_status: 'requesting',
      to_status: 'moving',
      event: 'CONFIRM',
    });

    // 커밋된 이벤트: 병원마다 request.changed, 팀에 '이하준 님이 B병원을 선택했어요', B병원 도착 예정
    const { rows: events } = await ctx.pool.query(
      `SELECT room, name, payload FROM event_log
        WHERE name IN ('request.changed', 'transport.confirmed', 'incoming.added') ORDER BY seq`,
    );
    assert.deepEqual(
      events.map((e) => e.name),
      [
        'request.changed',
        'request.changed',
        'request.changed',
        'transport.confirmed',
        'incoming.added',
      ],
    );
    const confirmed = events.find((e) => e.name === 'transport.confirmed')!;
    assert.equal(confirmed.payload.hospitalName, 'B병원');
    assert.equal(confirmed.payload.byName, '김도윤');
    assert.ok(!JSON.stringify(events).includes('두통'));
  });
});

test('같은 키로 다시 보내면 처음 결과를 그대로 주고 두 번 처리하지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const key = randomUUID();
    const body = { hospitalRequestId: s.req['B병원'], version: 1 };
    const first = await confirm(ctx, s.kim, s.transportId, body, key);
    const count = async () =>
      (await ctx.pool.query('SELECT count(*)::int AS n FROM event_log')).rows[0].n;
    const before = await count();

    const again = await confirm(ctx, s.kim, s.transportId, body, key);
    assert.equal(again.status, 200);
    assert.equal(again.body.version, first.body.version);
    assert.equal(again.body.status, 'moving');
    assert.equal(await count(), before);
    const { rows } = await ctx.pool.query('SELECT version FROM transport WHERE id = $1', [
      s.transportId,
    ]);
    assert.equal(rows[0].version, 2);
  });
});

test('두 팀원이 같은 버전으로 동시에 확정하면 먼저 온 것만 반영하고 다른 쪽에는 최신 상태를 준다 (SFR-160)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const [a, b] = await Promise.all([
      confirm(ctx, s.kim, s.transportId, { hospitalRequestId: s.req['B병원'], version: 1 }),
      confirm(ctx, s.lee, s.transportId, { hospitalRequestId: s.req['C병원'], version: 1 }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const lost = a.status === 409 ? a : b;
    // 늦게 온 쪽이 볼 때는 이미 '이동 중'이라 표에서 먼저 막힌다 (검사 순서: 표 → 상태 → 버전, stateMachine.ts 규칙 2)
    assert.equal(lost.body.error.code, 'INVALID_TRANSITION');
    assert.equal(lost.body.error.details.current.status, 'moving');
    assert.equal(lost.body.error.details.current.version, 2);
    const confirmed = (await requestStates(ctx.pool)).filter((r) => r[1] === 'confirmed');
    assert.equal(confirmed.length, 1);
  });
});

test('옛 버전·버전 없음·키 없음·남의 이송 건·없는 요청은 확정하지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const b = s.req['B병원'];
    const stale = await confirm(ctx, s.kim, s.transportId, { hospitalRequestId: b, version: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal(stale.body.error.details.current.status, 'requesting');

    const noVersion = await confirm(ctx, s.kim, s.transportId, { hospitalRequestId: b });
    assert.equal(noVersion.status, 400);
    assert.equal(noVersion.body.error.code, 'VERSION_REQUIRED');

    const noKey = await confirm(
      ctx,
      s.kim,
      s.transportId,
      { hospitalRequestId: b, version: 1 },
      null,
    );
    assert.equal(noKey.status, 400);

    const other = await login(ctx, 'park01');
    await request(appFor(ctx))
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${other}`)
      .send({ role: 'driver' });
    const notMine = await confirm(ctx, other, s.transportId, { hospitalRequestId: b, version: 1 });
    assert.equal(notMine.status, 404);
    assert.equal(notMine.body.error.code, 'NOT_FOUND');

    const unknown = await confirm(ctx, s.kim, s.transportId, {
      hospitalRequestId: 999999,
      version: 1,
    });
    assert.equal(unknown.status, 404);
    assert.equal((await requestStates(ctx.pool)).filter((r) => r[1] === 'confirmed').length, 0);
  });
});

test('승인 취소·대기 중·5분 지난 병원은 이유별 코드로 거절한다 (SFR-134)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await ctx.pool.query(
      `UPDATE hospital_request SET status = 'closed', closed_reason = 'approval_cancelled' WHERE id = $1`,
      [s.req['C병원']],
    );
    const cancelled = await confirm(ctx, s.kim, s.transportId, {
      hospitalRequestId: s.req['C병원'],
      version: 1,
    });
    assert.equal(cancelled.body.error.code, 'APPROVAL_CANCELLED');

    const waiting = await confirm(ctx, s.kim, s.transportId, {
      hospitalRequestId: s.req['D병원'],
      version: 1,
    });
    assert.equal(waiting.body.error.code, 'REQUEST_NOT_APPROVED');

    await ctx.pool.query(
      `UPDATE request_round SET approval_valid_until = now() - interval '1 second'`,
    );
    const expired = await confirm(ctx, s.kim, s.transportId, {
      hospitalRequestId: s.req['B병원'],
      version: 1,
    });
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error.code, 'APPROVAL_EXPIRED');
  });
});

test('5분은 첫 시도가 도착한 시각으로 판정한다: 마감 전에 처음 보낸 확정은 마감 뒤 재시도로도 확정된다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await ctx.pool.query(
      `UPDATE request_round SET approval_valid_until = now() + interval '700 milliseconds'`,
    );
    const key = randomUUID();
    // 첫 시도는 마감 전에 도착했지만 처리되지 못했다 (여기서는 버전을 빠뜨려 400)
    const first = await confirm(
      ctx,
      s.kim,
      s.transportId,
      { hospitalRequestId: s.req['B병원'] },
      key,
    );
    assert.equal(first.status, 400);
    await new Promise((r) => setTimeout(r, 900));

    // 마감 뒤 새 키로 보내면 만료
    const fresh = await confirm(ctx, s.kim, s.transportId, {
      hospitalRequestId: s.req['B병원'],
      version: 1,
    });
    assert.equal(fresh.body.error.code, 'APPROVAL_EXPIRED');
    // 같은 키로 재시도하면 첫 도착 시각 기준이라 확정된다
    const retry = await confirm(
      ctx,
      s.kim,
      s.transportId,
      { hospitalRequestId: s.req['B병원'], version: 1 },
      key,
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, 'moving');
  });
});

test('예비 추천 상태에서는 확정할 수 없다 (상태 전이표)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await ctx.pool.query(`UPDATE transport SET status = 'fallback' WHERE id = $1`, [s.transportId]);
    const res = await confirm(ctx, s.kim, s.transportId, {
      hospitalRequestId: s.req['B병원'],
      version: 1,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INVALID_TRANSITION');
    assert.equal(res.body.error.details.current.status, 'fallback');
  });
});
