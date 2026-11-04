// SFR-082·152 인수 기준(비밀번호 + OTP, 첫 로그인 OTP 연결, 5번 실패 잠금)을 임시 DB·실제 Redis 에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { generate, generateSecret } from 'otplib';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { hashPassword } from '../auth/password.js';
import { signAccessToken, signingKey } from '../auth/tokens.js';
import { TEST_REDIS_URL, withSchemaPool } from '../../testing/services.js';
import { LOCK_MINUTES, MAX_FAILURES } from './auth.js';
import { verifyAdminAccessToken } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'admin-password-1234';

interface Harness {
  pool: pg.Pool;
  jwtKey: Uint8Array;
  login: (body: object, origin?: string) => request.Test;
  enroll: (body: object) => request.Test;
}

async function withAdminApp(use: (h: Harness) => Promise<void>): Promise<void> {
  await withSchemaPool(async (pool) => {
    const redis = new Redis(TEST_REDIS_URL, { keyPrefix: `t_${randomBytes(6).toString('hex')}:` });
    const jwtKey = signingKey(randomBytes(32).toString('base64'));
    try {
      const app = createApp({
        logger,
        healthChecks: { db: ok, redis: ok },
        admin: { pool, redis, jwtKey, sessionHours: 14, allowedOrigins: [ORIGIN] },
      });
      await use({
        pool,
        jwtKey,
        login: (body, origin = ORIGIN) =>
          request(app).post('/api/v1/admin/auth/login').set('Origin', origin).send(body),
        enroll: (body) =>
          request(app).post('/api/v1/admin/auth/otp/enroll').set('Origin', ORIGIN).send(body),
      });
    } finally {
      redis.disconnect();
    }
  });
}

let passwordHash: Promise<string> | undefined;

// OTP 를 이미 연결한 관리자면 그 비밀 키를 돌려준다
async function addAdmin(pool: pg.Pool, { enrolled = false } = {}): Promise<string | null> {
  passwordHash ??= hashPassword(PASSWORD);
  const secret = enrolled ? await generateSecret() : null;
  await pool.query(
    `INSERT INTO admin (login_id, password_hash, name, otp_secret, otp_enrolled_at)
     VALUES ('admin', $1, '관리자', $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END)`,
    [await passwordHash, secret],
  );
  return secret;
}

// 휴대폰 OTP 앱이 지금 보여 줄 6자리
const codeFor = (secret: string) => generate({ secret });

test('OTP 를 연결한 관리자는 비밀번호 + OTP 로 로그인해 관리자 토큰을 받는다', async () => {
  await withAdminApp(async ({ pool, jwtKey, login }) => {
    const secret = (await addAdmin(pool, { enrolled: true }))!;

    const res = await login({ loginId: 'admin', password: PASSWORD, otp: await codeFor(secret) });

    assert.equal(res.status, 200);
    const verified = await verifyAdminAccessToken(jwtKey, res.body.accessToken);
    assert.equal(verified.ok, true);
    assert.equal(typeof res.body.refreshToken, 'string');
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM refresh_token WHERE owner_type = 'admin'",
    );
    assert.equal(rows[0].n, 1);
  });
});

test('연결한 뒤에는 OTP 가 없거나 틀리면 INVALID_OTP', async () => {
  await withAdminApp(async ({ pool, login }) => {
    await addAdmin(pool, { enrolled: true });
    for (const body of [
      { loginId: 'admin', password: PASSWORD },
      { loginId: 'admin', password: PASSWORD, otp: '000000' },
    ]) {
      const res = await login(body);
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_OTP');
    }
  });
});

test('한 번 쓴 OTP 는 다시 못 쓴다', async () => {
  await withAdminApp(async ({ pool, login }) => {
    const secret = (await addAdmin(pool, { enrolled: true }))!;
    const code = await codeFor(secret);
    assert.equal((await login({ loginId: 'admin', password: PASSWORD, otp: code })).status, 200);
    const again = await login({ loginId: 'admin', password: PASSWORD, otp: code });
    assert.equal(again.body.error.code, 'INVALID_OTP');
  });
});

test('첫 로그인이면 OTP 연결 정보를 주고, 앱 코드로 연결하면 바로 로그인된다', async () => {
  await withAdminApp(async ({ pool, jwtKey, login, enroll }) => {
    await addAdmin(pool);

    const first = await login({ loginId: 'admin', password: PASSWORD });
    assert.equal(first.status, 403);
    assert.equal(first.body.error.code, 'OTP_SETUP_REQUIRED');
    const { setupToken, otpauthUrl } = first.body.error.details;
    const secret = new URL(otpauthUrl).searchParams.get('secret')!;
    assert.ok(secret.length >= 16);
    // 연결이 끝나기 전에는 DB 에 비밀 키를 저장하지 않는다
    const before = await pool.query('SELECT otp_secret FROM admin');
    assert.equal(before.rows[0].otp_secret, null);

    const res = await enroll({ setupToken, otp: await codeFor(secret) });
    assert.equal(res.status, 200);
    assert.equal((await verifyAdminAccessToken(jwtKey, res.body.accessToken)).ok, true);

    const after = await pool.query('SELECT otp_secret, otp_enrolled_at FROM admin');
    assert.equal(after.rows[0].otp_secret, secret);
    assert.ok(after.rows[0].otp_enrolled_at);

    // 같은 연결 정보는 한 번만 쓴다
    const reuse = await enroll({ setupToken, otp: '123456' });
    assert.equal(reuse.body.error.code, 'TOKEN_EXPIRED');
  });
});

test('없는 연결 정보면 TOKEN_EXPIRED, 연결 코드를 5번 틀리면 연결 정보가 사라진다', async () => {
  await withAdminApp(async ({ pool, login, enroll }) => {
    await addAdmin(pool);
    assert.equal(
      (await enroll({ setupToken: 'made-up', otp: '123456' })).body.error.code,
      'TOKEN_EXPIRED',
    );

    const first = await login({ loginId: 'admin', password: PASSWORD });
    const { setupToken, otpauthUrl } = first.body.error.details;
    for (let i = 0; i < 5; i++) {
      assert.equal((await enroll({ setupToken, otp: '000000' })).body.error.code, 'INVALID_OTP');
    }
    const secret = new URL(otpauthUrl).searchParams.get('secret')!;
    const late = await enroll({ setupToken, otp: await codeFor(secret) });
    assert.equal(late.body.error.code, 'TOKEN_EXPIRED');
  });
});

test('비밀번호를 5번 틀리면 10분 동안 맞는 비밀번호도 막는다', async () => {
  await withAdminApp(async ({ pool, login }) => {
    const secret = (await addAdmin(pool, { enrolled: true }))!;
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      const res = await login({ loginId: 'admin', password: 'wrong' });
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    }
    const fifth = await login({ loginId: 'admin', password: 'wrong' });
    assert.equal(fifth.status, 423);
    assert.equal(fifth.body.error.code, 'ACCOUNT_LOCKED');
    const wait = fifth.body.error.details.retryAfterSeconds;
    assert.ok(wait > LOCK_MINUTES * 60 - 10 && wait <= LOCK_MINUTES * 60);

    const right = await login({ loginId: 'admin', password: PASSWORD, otp: await codeFor(secret) });
    assert.equal(right.body.error.code, 'ACCOUNT_LOCKED');
  });
});

test('틀린 OTP 도 실패로 센다', async () => {
  await withAdminApp(async ({ pool, login }) => {
    await addAdmin(pool, { enrolled: true });
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await login({ loginId: 'admin', password: PASSWORD, otp: '000000' });
    }
    const res = await login({ loginId: 'admin', password: PASSWORD, otp: '000000' });
    assert.equal(res.body.error.code, 'ACCOUNT_LOCKED');
  });
});

test('없는 아이디는 비밀번호 틀림과 같은 답', async () => {
  await withAdminApp(async ({ login }) => {
    const res = await login({ loginId: 'nobody', password: PASSWORD });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
  });
});

test('허용되지 않은 사이트에서 온 로그인은 막는다', async () => {
  await withAdminApp(async ({ pool, login }) => {
    await addAdmin(pool);
    const res = await login({ loginId: 'admin', password: PASSWORD }, 'https://evil.example');
    assert.equal(res.body.error.code, 'ORIGIN_NOT_ALLOWED');
  });
});

test('대원 토큰은 관리자 토큰으로 인정하지 않는다', async () => {
  const key = signingKey(randomBytes(32).toString('base64'));
  const paramedicToken = await signAccessToken(key, { paramedicId: '1', sessionVersion: 1 });
  assert.deepEqual(await verifyAdminAccessToken(key, paramedicToken), {
    ok: false,
    reason: 'invalid',
  });
});
