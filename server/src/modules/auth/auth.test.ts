// SFR-018·SER-016·SER-007 인수 기준을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import { endSessions, forgetSessionState, type AuthContext } from './session.js';
import { signAccessToken, signingKey } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

function appFor(ctx: AuthContext) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
}

function login(ctx: AuthContext, password = TEST_PASSWORD, loginId = 'kim01') {
  return request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password, deviceId: 'device-1' });
}

function me(ctx: AuthContext, accessToken: string) {
  return request(appFor(ctx)).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
}

test('맞는 아이디·비밀번호면 토큰과 내 정보를 준다. 로그인 직후에는 팀이 없다', async () => {
  await withAuthContext(async (ctx) => {
    const id = await addParamedic(ctx.pool);
    const res = await login(ctx);

    assert.equal(res.status, 200);
    assert.ok(res.body.tokens.accessToken);
    assert.ok(res.body.tokens.refreshToken);
    assert.deepEqual(
      { ...res.body.me, appliedAt: undefined },
      {
        id: Number(id),
        name: '김도윤',
        rank: '소방교',
        agency: '테스트소방서',
        safetyCenter: '테스트안전센터',
        status: 'approved',
        rejectReason: null,
        appliedAt: undefined,
        mustChangePassword: false,
        teamId: null,
        hasActiveTransport: false,
      },
    );

    // 갱신 토큰은 해시만 저장하고, 로그인부터 14시간 뒤에 끝난다 (SER-007)
    const { rows } = await ctx.pool.query(
      `SELECT token_hash, round(extract(epoch FROM expires_at - created_at) / 3600) AS hours
         FROM refresh_token`,
    );
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, res.body.tokens.refreshToken);
    assert.equal(rows[0].hours, '14');
  });
});

test('틀린 비밀번호와 없는 아이디는 같은 오류로 답한다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool);
    for (const res of [await login(ctx, 'wrong'), await login(ctx, TEST_PASSWORD, 'nobody')]) {
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    }
  });
});

test('5번 연속 틀리면 10분 잠기고, 잠긴 동안은 맞는 비밀번호도 막는다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool);
    for (let i = 0; i < 4; i += 1) assert.equal((await login(ctx, 'wrong')).status, 401);

    const fifth = await login(ctx, 'wrong');
    assert.equal(fifth.status, 423);
    assert.equal(fifth.body.error.code, 'ACCOUNT_LOCKED');
    assert.ok(Math.abs(fifth.body.error.details.retryAfterSeconds - 600) <= 1);

    const right = await login(ctx);
    assert.equal(right.status, 423);

    // 10분이 지나면 다시 로그인된다 (DB 시각으로 판정)
    await ctx.pool.query(`UPDATE paramedic SET locked_until = now() - interval '1 second'`);
    assert.equal((await login(ctx)).status, 200);
  });
});

test('로그인에 성공하면 실패 횟수가 처음부터 다시 센다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool);
    for (let i = 0; i < 4; i += 1) await login(ctx, 'wrong');
    assert.equal((await login(ctx)).status, 200);
    assert.equal((await login(ctx, 'wrong')).status, 401);
  });
});

test('동시에 틀려도 실패 횟수가 빠지지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool);
    const results = await Promise.all(Array.from({ length: 5 }, () => login(ctx, 'wrong')));
    assert.deepEqual(results.map((res) => res.status).sort(), [401, 401, 401, 401, 423]);
  });
});

test('정지 계정은 비밀번호가 맞을 때만 정지라고 알려 준다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool, { status: 'suspended' });
    assert.equal((await login(ctx, 'wrong')).body.error.code, 'INVALID_CREDENTIALS');
    const res = await login(ctx);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ACCOUNT_SUSPENDED');
  });
});

test('탈퇴 계정은 없는 아이디처럼 답한다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool, { status: 'withdrawn' });
    assert.equal((await login(ctx)).body.error.code, 'INVALID_CREDENTIALS');
  });
});

test('반려 계정도 로그인은 되고 반려 사유를 받는다 (SFR-083)', async () => {
  await withAuthContext(async (ctx) => {
    const id = await addParamedic(ctx.pool, { status: 'rejected' });
    await ctx.pool.query(
      `INSERT INTO signup_request (paramedic_id, consent_at, result, reject_reason, created_at)
       VALUES ($1, now(), 'rejected', 'photo_unclear', now() - interval '1 day'),
              ($1, now(), 'rejected', 'info_mismatch', now())`,
      [id],
    );
    const res = await login(ctx);
    assert.equal(res.status, 200);
    assert.equal(res.body.me.status, 'rejected');
    assert.equal(res.body.me.rejectReason, 'info_mismatch');
  });
});

test('입력이 빠지면 400이고 빠진 칸 이름만 알려 준다', async () => {
  await withAuthContext(async (ctx) => {
    const res = await request(appFor(ctx))
      .post('/api/v1/auth/login')
      .send({ loginId: 'kim01', password: 'secret-value' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details.fields, ['deviceId']);
    assert.ok(!res.text.includes('secret-value'));
  });
});

test('갱신 토큰은 한 번만 쓸 수 있고, 바꿔도 근무 종료 시각은 늘어나지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool);
    const { refreshToken } = (await login(ctx)).body.tokens;
    const refresh = (token: string) =>
      request(appFor(ctx)).post('/api/v1/auth/refresh').send({ refreshToken: token });

    const first = await refresh(refreshToken);
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refreshToken, refreshToken);
    assert.equal((await me(ctx, first.body.accessToken)).status, 200);

    const reused = await refresh(refreshToken);
    assert.equal(reused.status, 401);
    assert.equal(reused.body.error.code, 'TOKEN_REVOKED');

    const { rows } = await ctx.pool.query(
      'SELECT count(DISTINCT expires_at) AS ends, count(*) AS tokens FROM refresh_token',
    );
    assert.deepEqual(rows[0], { ends: '1', tokens: '2' });

    // 14시간이 지나면 다시 로그인해야 한다
    await ctx.pool.query(`UPDATE refresh_token SET expires_at = now() - interval '1 second'`);
    const expired = await refresh(first.body.refreshToken);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, 'TOKEN_EXPIRED');
  });
});

test('같은 갱신 토큰으로 동시에 두 번 와도 한 번만 바꿔 준다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool);
    const { refreshToken } = (await login(ctx)).body.tokens;
    const results = await Promise.all(
      [1, 2].map(() => request(appFor(ctx)).post('/api/v1/auth/refresh').send({ refreshToken })),
    );
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 401]);
  });
});

test('정지·로그아웃하면 접근 토큰이 남아 있어도 바로 막힌다 (SER-016)', async () => {
  await withAuthContext(async (ctx) => {
    const id = await addParamedic(ctx.pool);
    const { accessToken, refreshToken } = (await login(ctx)).body.tokens;
    assert.equal((await me(ctx, accessToken)).status, 200);

    await endSessions(ctx, ctx.pool, id);

    const res = await me(ctx, accessToken);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'TOKEN_REVOKED');
    const refreshed = await request(appFor(ctx))
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    assert.equal(refreshed.body.error.code, 'TOKEN_REVOKED');
  });
});

test('정지된 계정은 403이고, 캐시를 못 지워도 10초 안에 DB 값을 다시 본다', async () => {
  await withAuthContext(async (ctx) => {
    const id = await addParamedic(ctx.pool);
    const { accessToken } = (await login(ctx)).body.tokens;
    await me(ctx, accessToken);
    const ttl = await ctx.redis.ttl(`auth:paramedic:${id}`);
    assert.ok(ttl > 0 && ttl <= 10, `TTL ${ttl}`);

    await ctx.pool.query(`UPDATE paramedic SET status = 'suspended' WHERE id = $1`, [id]);
    await forgetSessionState(ctx, id);
    const res = await me(ctx, accessToken);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ACCOUNT_SUSPENDED');
  });
});

test('만료된 접근 토큰은 TOKEN_EXPIRED, 위조·형식 오류는 TOKEN_REVOKED다', async () => {
  await withAuthContext(async (ctx) => {
    const id = await addParamedic(ctx.pool);
    const expired = await new SignJWT({ sv: 1, typ: 'paramedic' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setIssuer('savetime')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(ctx.jwtKey);
    assert.equal((await me(ctx, expired)).body.error.code, 'TOKEN_EXPIRED');

    const otherKey = signingKey('another-secret-another-secret-123456');
    const forged = await signAccessToken(otherKey, { paramedicId: id, sessionVersion: 1 });
    for (const token of [forged, 'not-a-jwt']) {
      const res = await me(ctx, token);
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'TOKEN_REVOKED');
    }
  });
});

test('Redis가 안 돼도 DB로 계정 상태를 확인한다 (그냥 통과시키지 않음)', async () => {
  await withAuthContext(async (ctx) => {
    const id = await addParamedic(ctx.pool);
    const down = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    down.on('error', () => {});
    try {
      const broken = { ...ctx, redis: down };
      const token = await signAccessToken(ctx.jwtKey, { paramedicId: id, sessionVersion: 1 });
      assert.equal((await me(broken, token)).status, 200);

      await ctx.pool.query(`UPDATE paramedic SET status = 'suspended' WHERE id = $1`, [id]);
      assert.equal((await me(broken, token)).status, 403);
    } finally {
      down.disconnect();
    }
  });
});
