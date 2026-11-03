// SFR-071 회원 탈퇴 인수 기준을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import type { AuthContext } from './session.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

function appFor(ctx: AuthContext) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
}

function login(ctx: AuthContext, loginId: string) {
  return request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
}

async function token(ctx: AuthContext, loginId: string): Promise<string> {
  const res = await login(ctx, loginId);
  assert.equal(res.status, 200);
  return res.body.tokens.accessToken;
}

function withdraw(ctx: AuthContext, accessToken: string, confirm = false) {
  return request(appFor(ctx))
    .delete(`/api/v1/me${confirm ? '?confirmCancelActive=true' : ''}`)
    .set('Authorization', `Bearer ${accessToken}`);
}

test('탈퇴하면 프로필·푸시·메모가 지워지고 같은 아이디로 로그인되지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const id = await addParamedic(ctx.pool, { loginId: 'kim01' });
    const other = await addParamedic(ctx.pool, { loginId: 'lee01' });
    const access = await token(ctx, 'kim01');
    await ctx.pool.query(
      `INSERT INTO push_device (paramedic_id, device_id, platform, fcm_token) VALUES ($1, 'd1', 'android', 'fcm')`,
      [id],
    );
    await ctx.pool.query(
      `INSERT INTO paramedic_memo (owner_id, target_id, memo) VALUES ($1, $2, '메모'), ($2, $1, '메모')`,
      [id, other],
    );

    assert.equal((await withdraw(ctx, access)).status, 204);

    const { rows } = await ctx.pool.query(
      'SELECT status, login_id, name, employee_no, password_hash, withdrawn_at FROM paramedic WHERE id = $1',
      [id],
    );
    assert.equal(rows[0].status, 'withdrawn');
    assert.notEqual(rows[0].login_id, 'kim01');
    assert.equal(rows[0].name, '탈퇴한 대원');
    assert.equal(rows[0].employee_no, '');
    assert.equal(rows[0].password_hash, '');
    assert.ok(rows[0].withdrawn_at);

    for (const sql of [
      'SELECT 1 FROM push_device WHERE paramedic_id = $1',
      'SELECT 1 FROM paramedic_memo WHERE owner_id = $1 OR target_id = $1',
    ]) {
      assert.equal((await ctx.pool.query(sql, [id])).rows.length, 0);
    }

    const again = await login(ctx, 'kim01');
    assert.equal(again.status, 401);
    assert.equal(again.body.error.code, 'INVALID_CREDENTIALS');
    // 남아 있던 접근 토큰도 바로 막힌다
    const me = await request(appFor(ctx))
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${access}`);
    assert.equal(me.body.error.code, 'TOKEN_REVOKED');

    // 같은 아이디로 새 계정을 만들 수 있다
    await addParamedic(ctx.pool, { loginId: 'kim01' });
  });
});

test('승인 전 계정도 탈퇴할 수 있고, 심사 중이던 공무원증 사진도 지운다', async () => {
  await withAuthContext(async (ctx) => {
    const id = await addParamedic(ctx.pool, { loginId: 'wait', status: 'pending' });
    await ctx.pool.query(
      `INSERT INTO signup_request (paramedic_id, photo_key, consent_at) VALUES ($1, 'photos/1.jpg', now())`,
      [id],
    );
    assert.equal((await withdraw(ctx, await token(ctx, 'wait'))).status, 204);
    const { rows } = await ctx.pool.query(
      'SELECT photo_key FROM signup_request WHERE paramedic_id = $1',
      [id],
    );
    assert.equal(rows[0].photo_key, null);
  });
});

test('팀의 마지막 1명이면 확인을 받은 뒤 진행 중 이송을 취소(탈퇴)하고 팀을 해제한다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool, { loginId: 'kim01' });
    const access = await token(ctx, 'kim01');
    const team = await request(appFor(ctx))
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${access}`)
      .send({ role: 'driver' });
    const transportId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO transport (id, team_id, status, location_consent) VALUES ($1, $2, 'fallback', true)`,
      [transportId, team.body.id],
    );

    const ask = await withdraw(ctx, access);
    assert.equal(ask.status, 409);
    assert.equal(ask.body.error.code, 'ACTIVE_TRANSPORT_CONFIRM_REQUIRED');
    // 확인 전에는 아무것도 바뀌지 않는다
    const { rows: before } = await ctx.pool.query(
      "SELECT status FROM paramedic WHERE login_id = 'kim01'",
    );
    assert.equal(before[0].status, 'approved');

    assert.equal((await withdraw(ctx, access, true)).status, 204);
    const { rows } = await ctx.pool.query(
      `SELECT t.status, t.cancel_reason, tm.ended_at IS NOT NULL AS ended,
              (SELECT left_reason FROM team_member WHERE team_id = tm.id) AS left_reason
         FROM transport t JOIN team tm ON tm.id = t.team_id WHERE t.id = $1`,
      [transportId],
    );
    assert.deepEqual(rows[0], {
      status: 'cancelled',
      cancel_reason: 'withdrawal',
      ended: true,
      left_reason: 'withdrawal',
    });
  });
});
