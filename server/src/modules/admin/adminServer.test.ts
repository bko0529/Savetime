// 관리자 독립 서버 (T-11): IP 제한, 그리고 '보내기 전용' 실시간으로 main 서버에 붙은 앱에 정지를 알리는지.
// main 서버(연결 받음)와 관리자 서버(보내기 전용)를 같은 Redis 로 따로 띄워 실제 배포 모양 그대로 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import { WEB_ORIGIN } from '../../testing/hospitalWeb.js';
import { TEST_REDIS_URL } from '../../testing/services.js';
import type { AuthContext } from '../auth/session.js';
import { createRealtime } from '../realtime/server.js';
import { signAdminAccessToken } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

function adminApp(
  ctx: AuthContext,
  allowedIps: string[],
  realtime?: ReturnType<typeof createRealtime>,
) {
  return createApp({
    logger,
    healthChecks: { db: ok, redis: ok },
    realtime,
    admin: {
      pool: ctx.pool,
      redis: ctx.redis,
      jwtKey: ctx.jwtKey,
      sessionHours: 14,
      allowedOrigins: [WEB_ORIGIN],
      allowedIps,
    },
  });
}

async function adminToken(ctx: AuthContext): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    "INSERT INTO admin (login_id, password_hash, name) VALUES ('kim', 'x', '김관리') RETURNING id",
  );
  return signAdminAccessToken(ctx.jwtKey, rows[0].id);
}

test('허용 IP 가 아니면 관리자 API 는 로그인부터 403 IP_NOT_ALLOWED, 허용 IP 는 쓸 수 있다', async () => {
  await withAuthContext(async (ctx) => {
    const token = await adminToken(ctx);
    // 테스트 접속은 127.0.0.1(믿는 프록시)이라 X-Forwarded-For 를 실제 접속 주소로 본다 (Caddy 뒤와 같은 모양)
    const app = adminApp(ctx, ['203.0.113.10']);
    const call = (path: string, ip: string, method: 'get' | 'post' = 'get') =>
      request(app)
        [method](`/api/v1${path}`)
        .set('Origin', WEB_ORIGIN)
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${token}`);

    const blocked = await call('/admin/hospitals', '198.51.100.7');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'IP_NOT_ALLOWED');
    const login = await call('/admin/auth/login', '198.51.100.7', 'post').send({
      loginId: 'kim',
      password: 'x',
    });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'IP_NOT_ALLOWED');

    assert.equal((await call('/admin/hospitals', '203.0.113.10')).status, 200);
    // IPv6 모양으로 들어온 같은 IPv4 주소도 허용
    assert.equal((await call('/admin/hospitals', '::ffff:203.0.113.10')).status, 200);
    // 상태 점검은 IP 와 상관없이 (로드밸런서·UptimeRobot)
    assert.equal(
      (await request(app).get('/health').set('X-Forwarded-For', '198.51.100.7')).status,
      200,
    );
  });
});

test('허용 IP 목록이 비어 있으면 검사하지 않는다 (개발·테스트)', async () => {
  await withAuthContext(async (ctx) => {
    const token = await adminToken(ctx);
    const res = await request(adminApp(ctx, []))
      .get('/api/v1/admin/hospitals')
      .set('Origin', WEB_ORIGIN)
      .set('X-Forwarded-For', '198.51.100.7')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
  });
});

test('관리자 서버에서 대원을 정지하면 main 서버에 붙은 그 앱이 강제 로그아웃된다 (T-11, SFR-151)', async () => {
  await withAuthContext(async (ctx) => {
    const prefix = `t_${randomBytes(6).toString('hex')}`;
    // main 서버: 앱 연결을 받는다
    const mainRealtime = createRealtime({ auth: ctx, redisUrl: TEST_REDIS_URL, logger, prefix });
    const mainApp = createApp({
      logger,
      healthChecks: { db: ok, redis: ok },
      auth: ctx,
      realtime: mainRealtime,
    });
    const server = http.createServer(mainApp);
    mainRealtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // 관리자 서버: 연결은 받지 않고 보내기만 (같은 Redis, 같은 이름 앞붙이)
    const adminRealtime = createRealtime({
      auth: ctx,
      redisUrl: TEST_REDIS_URL,
      logger,
      prefix,
      runJobs: false,
    });
    const clients: ClientSocket[] = [];
    try {
      const kimId = await addParamedic(ctx.pool, { loginId: 'kim01' });
      await addParamedic(ctx.pool, { loginId: 'lee01' });
      const connect = async (loginId: string) => {
        const login = await request(mainApp)
          .post('/api/v1/auth/login')
          .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app`;
        const socket = connectClient(url, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          auth: { token: login.body.tokens.accessToken },
        });
        clients.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => resolve());
          socket.once('connect_error', reject);
        });
        return socket;
      };
      const kim = await connect('kim01');
      const lee = await connect('lee01');
      const forced = new Promise<{ data: unknown }>((resolve) =>
        kim.once('account.force_logout', resolve),
      );
      const closed = new Promise((resolve) => kim.once('disconnect', resolve));
      let leeForced = false;
      lee.on('account.force_logout', () => (leeForced = true));

      const res = await request(adminApp(ctx, [], adminRealtime))
        .post(`/api/v1/admin/paramedics/${kimId}/suspend`)
        .set('Origin', WEB_ORIGIN)
        .set('Authorization', `Bearer ${await adminToken(ctx)}`)
        .send({ reason: 'phone_lost' });
      assert.equal(res.status, 204);

      assert.deepEqual((await forced).data, { reason: 'suspended' });
      await closed;
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(leeForced, false);
      assert.ok(lee.connected);
    } finally {
      for (const c of clients) c.disconnect();
      await adminRealtime.close();
      await mainRealtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
