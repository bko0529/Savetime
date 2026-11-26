// 구급대원 웹앱(CR-010) 받기: 대원 API CORS · 웹 푸시 토큰 등록 · 웹 푸시 알림 설정
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../app.js';
import { buildMulticast } from '../modules/push/fcm.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../testing/auth.js';
import { WEB_ORIGIN } from '../testing/hospitalWeb.js';
import type { AuthContext } from '../modules/auth/session.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const APP_ORIGIN = 'https://savetime-app.lovable.app';
const OTHER_ORIGIN = 'https://evil.example';

function appFor(ctx: AuthContext) {
  return createApp({
    logger,
    healthChecks: { db: ok, redis: ok },
    auth: ctx,
    appOrigins: [APP_ORIGIN],
    hospitalWeb: { pool: ctx.pool, redis: ctx.redis, allowedOrigins: [WEB_ORIGIN] },
    admin: {
      pool: ctx.pool,
      redis: ctx.redis,
      jwtKey: ctx.jwtKey,
      sessionHours: 14,
      allowedOrigins: [WEB_ORIGIN],
    },
  });
}

test('허용한 앱 주소: 응답에 CORS 가 붙고, 오류 응답에서도 앱이 서버 시각·오류를 읽을 수 있다', async () => {
  await withAuthContext(async (ctx) => {
    // 토큰 없이 부르면 401 이지만, 앱이 오류 코드를 읽으려면 이 응답에도 CORS 가 있어야 한다
    const res = await request(appFor(ctx)).get('/api/v1/me').set('Origin', APP_ORIGIN);
    assert.equal(res.status, 401);
    assert.equal(res.headers['access-control-allow-origin'], APP_ORIGIN);
    assert.equal(res.headers['access-control-expose-headers'], 'X-Server-Now');
    assert.match(res.headers.vary ?? '', /Origin/);
    // 쿠키는 허락하지 않는다 (대원 앱은 Authorization 헤더)
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  });
});

test('확인 요청(OPTIONS)에는 204 로 허락할 방식·헤더를 알려 준다', async () => {
  await withAuthContext(async (ctx) => {
    const res = await request(appFor(ctx))
      .options('/api/v1/transports')
      .set('Origin', APP_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], APP_ORIGIN);
    assert.match(res.headers['access-control-allow-methods'], /POST/);
    assert.match(res.headers['access-control-allow-headers'], /Authorization/);
    assert.match(res.headers['access-control-allow-headers'], /Content-Type/);
    // 이송 확정은 Idempotency-Key 헤더를 보낸다 (SFR-111). 허락하지 않으면 브라우저가 확정 요청을 막는다
    assert.match(res.headers['access-control-allow-headers'], /Idempotency-Key/);
    assert.equal(res.headers['access-control-max-age'], '600');
  });
});

test('허용하지 않은 주소, 주소 없는 요청에는 CORS 를 붙이지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const other = await request(appFor(ctx)).get('/api/v1/me').set('Origin', OTHER_ORIGIN);
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    const preflight = await request(appFor(ctx))
      .options('/api/v1/me')
      .set('Origin', OTHER_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    // Origin 이 없는 요청(네이티브 앱·curl)은 예전처럼 그대로 된다
    const none = await request(appFor(ctx)).get('/api/v1/me');
    assert.equal(none.status, 401);
    assert.equal(none.headers['access-control-allow-origin'], undefined);
  });
});

test('병원 웹(/hw)·관리자(/admin)에는 앱 주소로 와도 CORS 를 열지 않는다 (SER-008)', async () => {
  await withAuthContext(async (ctx) => {
    for (const path of ['/api/v1/hw/requests', '/api/v1/admin/hospitals', '/api/v1/admin']) {
      const res = await request(appFor(ctx)).get(path).set('Origin', APP_ORIGIN);
      assert.equal(res.headers['access-control-allow-origin'], undefined, path);
      const preflight = await request(appFor(ctx))
        .options(path)
        .set('Origin', APP_ORIGIN)
        .set('Access-Control-Request-Method', 'GET');
      assert.equal(preflight.headers['access-control-allow-origin'], undefined, path);
    }
  });
});

test('APP_ORIGINS 가 비어 있으면 어떤 주소에도 CORS 를 열지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const app = createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
    const res = await request(app).get('/api/v1/me').set('Origin', APP_ORIGIN);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

test('웹앱은 브라우저 푸시 토큰을 platform web 으로 등록한다 (CR-010, SFR-130)', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool, { loginId: 'kim01' });
    const app = appFor(ctx);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', APP_ORIGIN)
      .send({ loginId: 'kim01', password: TEST_PASSWORD, deviceId: 'browser-1' });
    assert.equal(login.status, 200);
    assert.equal(login.headers['access-control-allow-origin'], APP_ORIGIN);

    const res = await request(app)
      .put('/api/v1/me/push-device')
      .set('Origin', APP_ORIGIN)
      .set('Authorization', `Bearer ${login.body.tokens.accessToken}`)
      .send({ deviceId: 'browser-1', platform: 'web', fcmToken: 'web-token-1' });
    assert.equal(res.status, 204);
    const { rows } = await ctx.pool.query('SELECT device_id, platform, fcm_token FROM push_device');
    assert.deepEqual(rows, [{ device_id: 'browser-1', platform: 'web', fcm_token: 'web-token-1' }]);
  });
});

test('푸시 메시지에 웹 푸시 설정이 붙고, Android·iPhone 설정은 그대로다', () => {
  const msg = buildMulticast({ title: '세이브타임', body: 'A병원 승인', data: { event: 'x' } });
  assert.deepEqual(msg.notification, { title: '세이브타임', body: 'A병원 승인' });
  assert.deepEqual(msg.data, { event: 'x' });
  assert.deepEqual(msg.webpush, {
    headers: { Urgency: 'high' },
    notification: { requireInteraction: true },
  });
  assert.equal(msg.android?.priority, 'high');
  assert.deepEqual(msg.apns, { payload: { aps: { sound: 'default' } } });
});
