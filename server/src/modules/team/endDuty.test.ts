// SFR-070 로그아웃과 근무 끝내기(SFR-113)를 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { withTransaction } from '../../db/transaction.js';
import { TransitionError } from '../../domain/stateMachine.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import type { AuthContext } from '../auth/session.js';
import { cancelTransport } from '../transport/cancel.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

function appFor(ctx: AuthContext) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
}

async function login(ctx: AuthContext, loginId: string) {
  const res = await request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  assert.equal(res.status, 200);
  return res.body.tokens as { accessToken: string; refreshToken: string };
}

function logout(ctx: AuthContext, accessToken: string, confirm = false) {
  return request(appFor(ctx))
    .post(`/api/v1/auth/logout${confirm ? '?confirmCancelActive=true' : ''}`)
    .set('Authorization', `Bearer ${accessToken}`);
}

async function makeTeam(pool: pg.Pool, memberIds: string[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ('4821', 'qr', $1) RETURNING id`,
    [memberIds[0]],
  );
  for (const [i, id] of memberIds.entries()) {
    await pool.query(`INSERT INTO team_member (team_id, paramedic_id, role) VALUES ($1, $2, $3)`, [
      rows[0].id,
      id,
      i === 0 ? 'driver' : 'care',
    ]);
  }
  return rows[0].id;
}

// 확정 병원(A) 하나와, 같은 회차의 대기·승인·거절 요청을 가진 이동 중 이송 건
async function makeMovingTransport(pool: pg.Pool, teamId: string) {
  const id = randomUUID();
  const hospitals: string[] = [];
  for (const name of ['A병원', 'B병원', 'C병원', 'D병원']) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO hospital (public_id, name, lat, lng) VALUES ($1, $1, 36.8, 127.1) RETURNING id`,
      [name],
    );
    hospitals.push(rows[0].id);
  }
  await pool.query(
    `INSERT INTO transport (id, team_id, status, location_consent, confirmed_hospital_id)
     VALUES ($1, $2, 'moving', true, $3)`,
    [id, teamId, hospitals[0]],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() + interval '2 minutes', now() + interval '5 minutes') RETURNING id`,
    [id],
  );
  const statuses = ['confirmed', 'waiting', 'approved', 'rejected'];
  for (const [i, status] of statuses.entries()) {
    await pool.query(
      `INSERT INTO hospital_request (round_id, hospital_id, status) VALUES ($1, $2, $3)`,
      [rows[0].id, hospitals[i], status],
    );
  }
  return id;
}

async function requestStates(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT h.name, hr.status, hr.closed_reason, hr.version
       FROM hospital_request hr JOIN hospital h ON h.id = hr.hospital_id ORDER BY h.name`,
  );
  return rows;
}

test('팀 없이 로그아웃하면 접근 토큰과 갱신 토큰이 모두 막힌다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool);
    const tokens = await login(ctx, 'kim01');

    const res = await logout(ctx, tokens.accessToken);
    assert.equal(res.status, 204);

    const me = await request(appFor(ctx))
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    assert.equal(me.body.error.code, 'TOKEN_REVOKED');
    const refreshed = await request(appFor(ctx))
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });
    assert.equal(refreshed.body.error.code, 'TOKEN_REVOKED');
  });
});

test('승인 전 계정도 로그아웃할 수 있다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool, { status: 'pending' });
    const tokens = await login(ctx, 'kim01');
    assert.equal((await logout(ctx, tokens.accessToken)).status, 204);
  });
});

test('나만 팀에서 빠지고 남은 팀원과 팀은 그대로다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await addParamedic(ctx.pool, { loginId: 'kim01' });
    const lee = await addParamedic(ctx.pool, { loginId: 'lee01' });
    const teamId = await makeTeam(ctx.pool, [kim, lee]);
    const tokens = await login(ctx, 'kim01');

    assert.equal((await logout(ctx, tokens.accessToken)).status, 204);

    const { rows } = await ctx.pool.query(
      `SELECT paramedic_id, left_reason FROM team_member ORDER BY paramedic_id`,
    );
    assert.deepEqual(rows, [
      { paramedic_id: kim, left_reason: 'logout' },
      { paramedic_id: lee, left_reason: null },
    ]);
    const team = await ctx.pool.query('SELECT ended_at FROM team WHERE id = $1', [teamId]);
    assert.equal(team.rows[0].ended_at, null);
  });
});

test('진행 중 이송이 있는데 확인이 없으면 409이고 아무것도 바뀌지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await addParamedic(ctx.pool);
    const teamId = await makeTeam(ctx.pool, [kim]);
    const transportId = await makeMovingTransport(ctx.pool, teamId);
    const tokens = await login(ctx, 'kim01');

    const res = await logout(ctx, tokens.accessToken);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ACTIVE_TRANSPORT_CONFIRM_REQUIRED');
    assert.deepEqual(res.body.error.details.activeTransport, {
      id: transportId,
      status: 'moving',
      hospitalName: 'A병원',
    });

    const member = await ctx.pool.query('SELECT left_at FROM team_member');
    assert.equal(member.rows[0].left_at, null);
    const me = await request(appFor(ctx))
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    assert.equal(me.status, 200);
  });
});

test('마지막 1명이 확인하고 로그아웃하면 이송을 취소하고 병원 요청을 닫고 팀을 해제한다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await addParamedic(ctx.pool);
    const teamId = await makeTeam(ctx.pool, [kim]);
    const transportId = await makeMovingTransport(ctx.pool, teamId);
    const tokens = await login(ctx, 'kim01');

    assert.equal((await logout(ctx, tokens.accessToken, true)).status, 204);

    const transport = await ctx.pool.query(
      'SELECT status, cancel_reason, version, cancelled_at IS NOT NULL AS done FROM transport',
    );
    assert.deepEqual(transport.rows[0], {
      status: 'cancelled',
      cancel_reason: 'logout',
      version: 2,
      done: true,
    });
    const history = await ctx.pool.query(
      'SELECT transport_id, from_status, to_status, event, reason FROM transport_status_history',
    );
    assert.deepEqual(history.rows, [
      {
        transport_id: transportId,
        from_status: 'moving',
        to_status: 'cancelled',
        event: 'CANCEL',
        reason: 'logout',
      },
    ]);
    // 대기·승인·확정은 닫히고, 이미 거절한 요청은 그대로다
    assert.deepEqual(await requestStates(ctx.pool), [
      { name: 'A병원', status: 'closed', closed_reason: 'cancelled', version: 2 },
      { name: 'B병원', status: 'closed', closed_reason: 'cancelled', version: 2 },
      { name: 'C병원', status: 'closed', closed_reason: 'cancelled', version: 2 },
      { name: 'D병원', status: 'rejected', closed_reason: null, version: 1 },
    ]);
    const team = await ctx.pool.query('SELECT ended_at IS NOT NULL AS ended FROM team');
    assert.equal(team.rows[0].ended, true);
  });
});

test('남은 팀원이 있으면 확인하고 나가도 이송은 이어진다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await addParamedic(ctx.pool, { loginId: 'kim01' });
    const lee = await addParamedic(ctx.pool, { loginId: 'lee01' });
    const teamId = await makeTeam(ctx.pool, [kim, lee]);
    await makeMovingTransport(ctx.pool, teamId);
    const tokens = await login(ctx, 'kim01');

    assert.equal((await logout(ctx, tokens.accessToken, true)).status, 204);

    const transport = await ctx.pool.query('SELECT status FROM transport');
    assert.equal(transport.rows[0].status, 'moving');
    const team = await ctx.pool.query('SELECT ended_at FROM team');
    assert.equal(team.rows[0].ended_at, null);
  });
});

test('두 명이 동시에 로그아웃해도 이송은 정확히 한 번 취소된다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await addParamedic(ctx.pool, { loginId: 'kim01' });
    const lee = await addParamedic(ctx.pool, { loginId: 'lee01' });
    const teamId = await makeTeam(ctx.pool, [kim, lee]);
    await makeMovingTransport(ctx.pool, teamId);
    const [a, b] = [await login(ctx, 'kim01'), await login(ctx, 'lee01')];

    const results = await Promise.all([
      logout(ctx, a.accessToken, true),
      logout(ctx, b.accessToken, true),
    ]);
    assert.deepEqual(
      results.map((res) => res.status),
      [204, 204],
    );

    const history = await ctx.pool.query('SELECT count(*) FROM transport_status_history');
    assert.equal(history.rows[0].count, '1');
    const transport = await ctx.pool.query('SELECT status, version FROM transport');
    assert.deepEqual(transport.rows[0], { status: 'cancelled', version: 2 });
    const team = await ctx.pool.query('SELECT ended_at IS NOT NULL AS ended FROM team');
    assert.equal(team.rows[0].ended, true);
  });
});

test('이미 끝난 이송은 다시 취소할 수 없다 (상태 전이표)', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await addParamedic(ctx.pool);
    const teamId = await makeTeam(ctx.pool, [kim]);
    const transportId = await makeMovingTransport(ctx.pool, teamId);
    await withTransaction(ctx.pool, (client) => cancelTransport(client, transportId, 'logout'));

    await assert.rejects(
      withTransaction(ctx.pool, (client) => cancelTransport(client, transportId, 'logout')),
      (err: TransitionError) => err.code === 'INVALID_TRANSITION',
    );
  });
});

test('대원이 직접 취소할 때는 version이 필요하고, 다르면 거절한다 (SFR-160)', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await addParamedic(ctx.pool);
    const teamId = await makeTeam(ctx.pool, [kim]);
    const transportId = await makeMovingTransport(ctx.pool, teamId);
    const cancel = (version?: number) =>
      withTransaction(ctx.pool, (client) => cancelTransport(client, transportId, 'user', version));

    await assert.rejects(cancel(), (err: TransitionError) => err.code === 'VERSION_REQUIRED');
    await assert.rejects(cancel(5), (err: TransitionError) => err.code === 'VERSION_CONFLICT');
    const result = await cancel(1);
    assert.deepEqual(
      [result.from, result.version, result.closedRequestIds.length],
      ['moving', 2, 3],
    );
  });
});
