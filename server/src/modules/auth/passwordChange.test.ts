// PUT /me/password 를 5번 틀리면 로그인처럼 10분 잠근다 (SER-011, SFR-021)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

test('비밀번호 변경에서 지금 비밀번호를 5번 틀리면 10분 잠기고, 잠긴 동안은 맞아도 못 바꾸고 로그인도 막힌다', async () => {
  await withAuthContext(async (ctx) => {
    const app = createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
    await addParamedic(ctx.pool, { loginId: 'kim01' });
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ loginId: 'kim01', password: TEST_PASSWORD, deviceId: 'device-kim01' });
    const bearer = { Authorization: `Bearer ${loginRes.body.tokens.accessToken}` };
    const change = (currentPassword: string) =>
      request(app)
        .put('/api/v1/me/password')
        .set(bearer)
        .send({ currentPassword, newPassword: 'brand-new-1234' });

    for (let i = 0; i < 4; i += 1) {
      const res = await change('wrong-password');
      assert.equal(res.status, 401, `${i + 1}번째`);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    }
    const fifth = await change('wrong-password');
    assert.equal(fifth.status, 423);
    assert.equal(fifth.body.error.code, 'ACCOUNT_LOCKED');
    assert.ok(fifth.body.error.details.retryAfterSeconds > 500);

    // 잠긴 동안은 맞는 비밀번호여도 바꾸지 않고, 로그인도 같은 잠금으로 막힌다
    assert.equal((await change(TEST_PASSWORD)).status, 423);
    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ loginId: 'kim01', password: TEST_PASSWORD, deviceId: 'device-kim01' });
    assert.equal(relogin.status, 423);

    // 10분이 지나면 다시 되고, 바꾸면 실패 횟수도 0으로
    await ctx.pool.query("UPDATE paramedic SET locked_until = now() - interval '1 second'");
    assert.equal((await change('wrong-password')).status, 401);
    assert.equal((await change(TEST_PASSWORD)).status, 204);
    const { rows } = await ctx.pool.query('SELECT failed_count, locked_until FROM paramedic');
    assert.deepEqual(rows[0], { failed_count: 0, locked_until: null });
  });
});
