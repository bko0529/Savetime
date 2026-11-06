// SFR-130 대원 알림 푸시: 기기 등록, 문구(환자 정보 없음), 화면에 안 보이는 팀원에게만 발송을 확인한다.
// 실제 FCM 대신 가짜 발송 함수를 쓴다. 임시 DB와 실제 Redis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { io as connectClient } from 'socket.io-client';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { TEST_REDIS_URL } from '../../testing/services.js';
import { appFor, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';
import type { LoggedEvent } from '../realtime/eventLog.js';
import { createRealtime } from '../realtime/server.js';
import {
  createPushDispatcher,
  messageFor,
  setVisible,
  type PushMessage,
  type PushSender,
} from './dispatch.js';

const logger = pino({ level: 'silent' });

function registerDevice(ctx: AuthContext, token: string, deviceId: string, fcmToken: string) {
  return request(appFor(ctx))
    .put('/api/v1/me/push-device')
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId, platform: 'android', fcmToken });
}

async function teamId(ctx: AuthContext): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM team');
  return rows[0].id;
}

async function paramedicId(ctx: AuthContext, loginId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    'SELECT id FROM paramedic WHERE login_id = $1',
    [loginId],
  );
  return rows[0].id;
}

function event(name: string, room: string, payload: LoggedEvent['payload']): LoggedEvent {
  return { seq: 1, room, name, entityVersion: null, payload, occurredAt: new Date() };
}

// 가짜 발송: 받은 토큰과 문구를 모으고, deadTokens는 '더 이상 못 쓰는 토큰'이라고 답한다
function fakeSender(deadTokens: string[] = []) {
  const sent: { tokens: string[]; message: PushMessage }[] = [];
  const sender: PushSender = async (tokens, message) => {
    sent.push({ tokens: [...tokens].sort(), message });
    return { invalidTokens: tokens.filter((t) => deadTokens.includes(t)) };
  };
  return { sender, sent };
}

async function withDevices(ctx: AuthContext): Promise<Scene> {
  const s = await scene(ctx);
  await registerDevice(ctx, s.kim, 'kim-phone', 'token-kim');
  await registerDevice(ctx, s.lee, 'lee-phone', 'token-lee');
  return s;
}

test('푸시 기기 등록: 같은 기기는 토큰만 바꾸고, 입력이 틀리거나 로그인이 없으면 막는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    assert.equal((await registerDevice(ctx, s.kim, 'phone-1', 'old')).status, 204);
    assert.equal((await registerDevice(ctx, s.kim, 'phone-1', 'new')).status, 204);
    assert.equal((await registerDevice(ctx, s.kim, 'phone-2', 'tablet')).status, 204);
    const { rows } = await ctx.pool.query(
      'SELECT device_id, fcm_token FROM push_device ORDER BY device_id',
    );
    assert.deepEqual(rows, [
      { device_id: 'phone-1', fcm_token: 'new' },
      { device_id: 'phone-2', fcm_token: 'tablet' },
    ]);

    const bad = await request(appFor(ctx))
      .put('/api/v1/me/push-device')
      .set('Authorization', `Bearer ${s.kim}`)
      .send({ deviceId: 'x', platform: 'windows', fcmToken: 't' });
    assert.equal(bad.status, 400);
    const anonymous = await request(appFor(ctx))
      .put('/api/v1/me/push-device')
      .send({ deviceId: 'x', platform: 'ios', fcmToken: 't' });
    assert.equal(anonymous.status, 401);
  });
});

test('문구: 첫 승인·2분 만료·전부 거절만, 병원 이름·분·안내뿐이고 환자 정보는 없다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const team = `team:${await teamId(ctx)}`;
    const first = await messageFor(
      ctx.pool,
      event('request.approved', team, {
        transportId: s.transportId,
        hospitalRequestId: s.req['B병원'],
        firstApproval: true,
      }),
    );
    // B병원은 2.2km → 직선 추정 4분
    assert.equal(first?.body, 'B병원 승인 · 4분');
    assert.deepEqual(first?.data, { event: 'request.approved', transportId: s.transportId });

    const second = await messageFor(
      ctx.pool,
      event('request.approved', team, {
        transportId: s.transportId,
        hospitalRequestId: s.req['C병원'],
        firstApproval: false,
      }),
    );
    assert.equal(second, null);

    const expiredNone = await messageFor(
      ctx.pool,
      event('request.expired', team, { transportId: s.transportId, anyApproved: false }),
    );
    assert.equal(expiredNone?.body, '응답 시간 2분이 지났어요 · 가까운 병원에 전화로 확인하세요');
    const expiredSome = await messageFor(
      ctx.pool,
      event('request.expired', team, { transportId: s.transportId, anyApproved: true }),
    );
    assert.equal(expiredSome?.body, '응답 시간 2분이 지났어요 · 승인한 병원을 골라 주세요');

    const rejected = await messageFor(
      ctx.pool,
      event('transport.status', team, {
        transportId: s.transportId,
        status: 'fallback',
        reason: 'all_rejected',
      }),
    );
    assert.equal(rejected?.body, '모든 병원이 거절했어요 · 가까운 병원에 전화로 확인하세요');

    // 승인 취소 (SFR-128): 병원 이름 + 받침에 맞는 조사
    const cancelled = await messageFor(
      ctx.pool,
      event('request.cancelled', team, {
        transportId: s.transportId,
        hospitalRequestId: s.req['B병원'],
        hospitalName: 'B병원',
        reason: 'er_bed',
        wasConfirmed: true,
      }),
    );
    assert.equal(cancelled?.body, 'B병원이 승인을 취소했어요');
    assert.deepEqual(cancelled?.data, { event: 'request.cancelled', transportId: s.transportId });
    const noFinal = await messageFor(
      ctx.pool,
      event('request.cancelled', team, { transportId: s.transportId, hospitalName: '세브란스' }),
    );
    assert.equal(noFinal?.body, '세브란스가 승인을 취소했어요');

    // 승인 유효 5분 (SFR-127): 4분 경보와 5분 해제
    const expiring = await messageFor(
      ctx.pool,
      event('approval.expiring', team, {
        transportId: s.transportId,
        releaseAt: new Date().toISOString(),
      }),
    );
    assert.equal(expiring?.body, '1분 뒤 승인이 해제돼요 · 병원을 골라 주세요');
    assert.deepEqual(expiring?.data, { event: 'approval.expiring', transportId: s.transportId });
    const released = await messageFor(
      ctx.pool,
      event('approval.expired', team, { transportId: s.transportId }),
    );
    assert.equal(released?.body, '승인 시간 5분이 지나 해제됐어요 · 추천 병원을 확인하세요');

    // 추가 메모 (SFR-140): 병원 이름만, 메모 글은 없다
    const memo = await messageFor(
      ctx.pool,
      event('hospital.extra_memo', team, {
        transportId: s.transportId,
        hospitalRequestId: s.req['B병원'],
        hospitalName: 'B병원',
      }),
    );
    assert.equal(memo?.body, 'B병원이 추가 메모를 보냈어요');
    assert.deepEqual(memo?.data, { event: 'hospital.extra_memo', transportId: s.transportId });

    // 가입 결과 (SFR-022·083): 대원 개인 방
    const signupOk = await messageFor(
      ctx.pool,
      event('account.signup_result', 'paramedic:1', { result: 'approved', reason: null }),
    );
    assert.equal(signupOk?.body, '가입이 승인됐어요 · 로그인해서 근무를 시작하세요');
    assert.deepEqual(signupOk?.data, { event: 'account.signup_result', result: 'approved' });
    const signupNo = await messageFor(
      ctx.pool,
      event('account.signup_result', 'paramedic:1', {
        result: 'rejected',
        reason: 'photo_unclear',
      }),
    );
    assert.equal(signupNo?.body, '가입이 반려됐어요 · 사유를 확인하고 다시 신청해 주세요');

    // 다른 이유의 예비 전환·다른 이벤트는 S3 푸시 대상이 아니다
    for (const other of [
      event('transport.status', team, { status: 'fallback', reason: 'none_delivered' }),
      event('transport.created', team, { transportId: s.transportId }),
      event('request.rejected', team, { transportId: s.transportId }),
    ]) {
      assert.equal(await messageFor(ctx.pool, other), null);
    }
    for (const m of [
      first,
      expiredNone,
      expiredSome,
      rejected,
      cancelled,
      expiring,
      released,
      memo,
    ]) {
      assert.ok(!JSON.stringify(m).includes('두통'));
    }
  });
});

test('앱이 화면에 보이는 팀원은 빼고, 안 보이는 팀원 기기에만 보낸다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await withDevices(ctx);
    const team = `team:${await teamId(ctx)}`;
    const expired = event('request.expired', team, {
      transportId: s.transportId,
      anyApproved: false,
    });
    const { sender, sent } = fakeSender();
    const dispatcher = createPushDispatcher({ pool: ctx.pool, redis: ctx.redis, sender, logger });

    // 김도윤은 앱을 보고 있고, 이하준은 백그라운드
    await setVisible(ctx.redis, await paramedicId(ctx, 'kim01'), 'sock-1', true);
    await dispatcher.handle([expired]);
    assert.deepEqual(
      sent.map((x) => x.tokens),
      [['token-lee']],
    );

    // 둘 다 보고 있으면 푸시 없음
    await setVisible(ctx.redis, await paramedicId(ctx, 'lee01'), 'sock-2', true);
    await dispatcher.handle([expired]);
    assert.equal(sent.length, 1);

    // 둘 다 백그라운드면 둘 다
    await setVisible(ctx.redis, await paramedicId(ctx, 'kim01'), 'sock-1', false);
    await setVisible(ctx.redis, await paramedicId(ctx, 'lee01'), 'sock-2', false);
    await dispatcher.handle([expired]);
    assert.deepEqual(sent[1].tokens, ['token-kim', 'token-lee']);

    // 병원 방 이벤트·푸시 대상이 아닌 이벤트는 보내지 않는다
    await dispatcher.handle([
      event('request.changed', 'hospital:1', { requestId: 1 }),
      event('transport.created', team, { transportId: s.transportId }),
    ]);
    assert.equal(sent.length, 2);
  });
});

test('대원 개인 방 이벤트(가입 결과)는 그 대원 기기에만 보낸다 (SFR-022)', async () => {
  await withAuthContext(async (ctx) => {
    await withDevices(ctx);
    const kim = await paramedicId(ctx, 'kim01');
    const { sender, sent } = fakeSender();
    const dispatcher = createPushDispatcher({ pool: ctx.pool, redis: ctx.redis, sender, logger });
    await dispatcher.handle([
      event('account.signup_result', `paramedic:${kim}`, { result: 'approved', reason: null }),
    ]);
    assert.deepEqual(
      sent.map((x) => x.tokens),
      [['token-kim']],
    );
    // 앱을 보고 있으면 화면이 직접 알리므로 푸시하지 않는다
    await setVisible(ctx.redis, kim, 'sock-1', true);
    await dispatcher.handle([
      event('account.signup_result', `paramedic:${kim}`, { result: 'approved', reason: null }),
    ]);
    assert.equal(sent.length, 1);
  });
});

test('FCM이 못 쓰는 토큰이라고 하면 지워서 다음부터 보내지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await withDevices(ctx);
    const team = `team:${await teamId(ctx)}`;
    const { sender, sent } = fakeSender(['token-lee']);
    const dispatcher = createPushDispatcher({ pool: ctx.pool, redis: ctx.redis, sender, logger });
    const expired = event('request.expired', team, { transportId: s.transportId });
    await dispatcher.handle([expired]);
    const { rows } = await ctx.pool.query('SELECT fcm_token FROM push_device');
    assert.deepEqual(rows, [{ fcm_token: 'token-kim' }]);
    await dispatcher.handle([expired]);
    assert.deepEqual(sent[1].tokens, ['token-kim']);
  });
});

test('실시간 서버: 커밋된 이벤트를 보낼 때 app.visibility로 화면에 있는 대원은 빼고 푸시한다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await withDevices(ctx);
    const { sender, sent } = fakeSender();
    const realtime = createRealtime({
      auth: ctx,
      redisUrl: TEST_REDIS_URL,
      logger,
      prefix: `t_${randomBytes(6).toString('hex')}`,
      push: sender,
    });
    const server = http.createServer(appFor(ctx));
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app`;
    const socket = connectClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: s.kim },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      socket.emit('app.visibility', { visible: true });
      await new Promise((r) => setTimeout(r, 200));

      realtime.publish([
        event('request.expired', `team:${await teamId(ctx)}`, {
          transportId: s.transportId,
          anyApproved: false,
        }),
      ]);
      for (let i = 0; i < 30 && sent.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(
        sent.map((x) => x.tokens),
        [['token-lee']],
      );

      // 연결이 끊기면 '화면에 보임'도 지워져 다음에는 김도윤도 받는다
      socket.disconnect();
      await new Promise((r) => setTimeout(r, 200));
      realtime.publish([
        event('request.expired', `team:${await teamId(ctx)}`, {
          transportId: s.transportId,
          anyApproved: false,
        }),
      ]);
      for (let i = 0; i < 30 && sent.length < 2; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(sent[1].tokens, ['token-kim', 'token-lee']);
    } finally {
      socket.disconnect();
      await realtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
