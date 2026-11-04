// SFR-117 인수 기준(근무 시작 → 알림 켜기 → 그 탭만 요청 대상, 재연결 복구, 근무 종료)을
// 임시 DB·실제 Redis·실제 웹소켓 연결(실시간 서버 #28)로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { pino } from 'pino';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import { addHospitalWithKey, WEB_ORIGIN } from '../../testing/hospitalWeb.js';
import { TEST_REDIS_URL } from '../../testing/services.js';
import { createRealtime } from '../realtime/server.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

interface Harness {
  pool: pg.Pool;
  registerPc: (name: string) => Promise<string>;
  post: (path: string, cookie: string, body?: object) => request.Test;
  session: (cookie: string) => request.Test;
  // 브라우저 탭 하나처럼 /hospital 에 붙는다
  openTab: (cookie: string) => Promise<ClientSocket>;
  // 대원 API 등 쿠키 없이 부를 때
  api: () => ReturnType<typeof request>;
}

async function withShiftApp(use: (h: Harness) => Promise<void>): Promise<void> {
  await withAuthContext(async (auth) => {
    const realtime = createRealtime({
      auth,
      redisUrl: TEST_REDIS_URL,
      logger,
      prefix: `t_${randomBytes(6).toString('hex')}`,
      // 받았음 판정(5초)을 테스트에서는 짧게
      deliveryTimeoutMs: 600,
    });
    const hospitalWeb = {
      pool: auth.pool,
      redis: auth.redis,
      allowedOrigins: [WEB_ORIGIN],
      realtime,
    };
    const app = createApp({
      logger,
      healthChecks: { db: ok, redis: ok },
      auth,
      realtime,
      hospitalWeb,
    });
    const server = http.createServer(app);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tabs: ClientSocket[] = [];
    const { key } = await addHospitalWithKey(auth.pool);

    try {
      await use({
        api: () => request(server),
        pool: auth.pool,
        registerPc: async (pcName) => {
          const res = await request(server)
            .post('/api/v1/hw/pc/register')
            .set('Origin', WEB_ORIGIN)
            .send({ licenseKey: key, pcName });
          assert.equal(res.status, 201);
          const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
          return header.find((c) => c.startsWith('st_pc='))!.split(';')[0];
        },
        post: (path, cookie, body = {}) =>
          request(server)
            .post(`/api/v1${path}`)
            .set('Origin', WEB_ORIGIN)
            .set('Cookie', cookie)
            .send(body),
        session: (cookie) =>
          request(server).get('/api/v1/hw/session').set('Origin', WEB_ORIGIN).set('Cookie', cookie),
        openTab: (cookie) =>
          new Promise((resolve, reject) => {
            const socket = connectClient(`${url}/hospital`, {
              transports: ['websocket'],
              forceNew: true,
              reconnection: false,
              extraHeaders: { Cookie: cookie, Origin: WEB_ORIGIN },
            });
            tabs.push(socket);
            socket.once('connect', () => resolve(socket));
            socket.once('connect_error', reject);
          }),
      });
    } finally {
      for (const tab of tabs) tab.disconnect();
      await realtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

function nextEvent<T>(socket: ClientSocket, name: string, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} 이벤트가 오지 않았어요`)), ms);
    socket.once(name, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

// 이벤트가 오지 않아야 할 때: 잠깐 기다려 본다
function noEvent(socket: ClientSocket, name: string, ms = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    socket.once(name, () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function alarmOnAt(pool: pg.Pool): Promise<(Date | null)[]> {
  const { rows } = await pool.query(
    'SELECT alarm_on_at FROM hospital_shift WHERE ended_at IS NULL ORDER BY id',
  );
  return rows.map((r) => r.alarm_on_at);
}

async function eventually<T>(read: () => Promise<T>, check: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 40; i += 1) {
    const value = await read();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('기다린 값이 되지 않았어요');
}

interface AlarmOff {
  data: { reason: string };
}

test('근무 시작 → 알림 켜기를 누른 그 탭만 요청 대상이 된다', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const tab = await h.openTab(cookie);
    const other = await h.openTab(cookie); // 같은 PC 의 다른 탭 (알림 안 켬)

    const started = await h.post('/hw/shifts', cookie, { staffName: ' 박서연 ' });
    assert.equal(started.status, 201);
    const { shiftId } = started.body;
    let session = await h.session(cookie);
    assert.deepEqual(session.body.shift, { id: shiftId, staffName: '박서연', alarmOn: false });

    const on = await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: tab.id });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { shiftId });
    session = await h.session(cookie);
    assert.equal(session.body.shift.alarmOn, true);

    // 방에 안 들어간 탭이 끊겨도 알림은 그대로, 방에 들어간 탭이 끊기면 알림이 풀린다 (요청 대상에서 빠짐)
    other.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await alarmOnAt(h.pool))[0]);
    tab.disconnect();
    await eventually(
      () => alarmOnAt(h.pool),
      (v) => v[0] === null,
    );
  });
});

test('근무 전이거나 남의 PC 연결 id 면 알림을 켜지 않는다', async () => {
  await withShiftApp(async (h) => {
    const mine = await h.registerPc('접수대');
    const theirs = await h.registerPc('처치실');
    const myTab = await h.openTab(mine);
    const theirTab = await h.openTab(theirs);

    const early = await h.post('/hw/shifts/current/alarm-on', mine, { socketId: myTab.id });
    assert.equal(early.status, 404);
    assert.equal(early.body.error.code, 'NOT_FOUND');

    await h.post('/hw/shifts', mine, { staffName: '박서연' });
    for (const socketId of [theirTab.id, 'gone']) {
      const res = await h.post('/hw/shifts/current/alarm-on', mine, { socketId });
      assert.equal(res.status, 404);
    }
    assert.deepEqual(await alarmOnAt(h.pool), [null]);
  });
});

test('연결만 끊겼다 붙으면 같은 근무 id 로 알림을 되살린다 (alarm.resume)', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const first = await h.openTab(cookie);
    const { shiftId } = (await h.post('/hw/shifts', cookie, { staffName: '박서연' })).body;
    await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: first.id });
    first.disconnect();
    await eventually(
      () => alarmOnAt(h.pool),
      (v) => v[0] === null,
    );

    const again = await h.openTab(cookie);
    const resumed = await again.timeout(2000).emitWithAck('alarm.resume', { shiftId });
    assert.deepEqual(resumed, { ok: true });
    assert.ok((await alarmOnAt(h.pool))[0]);
  });
});

test('근무 종료 → 이 PC 탭들만 alarm_off(shift_ended)를 받고 근무가 끝난다', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const otherPc = await h.registerPc('처치실');
    const tab = await h.openTab(cookie);
    const otherTab = await h.openTab(otherPc);
    await h.post('/hw/shifts', cookie, { staffName: '박서연' });
    await h.post('/hw/shifts', otherPc, { staffName: '김도윤' });
    await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: tab.id });
    await h.post('/hw/shifts/current/alarm-on', otherPc, { socketId: otherTab.id });

    const off = nextEvent<AlarmOff>(tab, 'hospital.alarm_off');
    const otherQuiet = noEvent(otherTab, 'hospital.alarm_off');
    const res = await h.post('/hw/shifts/current/end', cookie);
    assert.equal(res.status, 204);
    assert.equal((await off).data.reason, 'shift_ended');
    assert.equal(await otherQuiet, true);

    assert.equal((await h.session(cookie)).body.shift, null);
    assert.equal((await h.session(otherPc)).body.shift.alarmOn, true);
    assert.equal((await h.post('/hw/shifts/current/end', cookie)).status, 404);
  });
});

test('근무 중에 근무를 새로 시작하면 앞 근무를 끝내고 하나만 남긴다', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const tab = await h.openTab(cookie);
    await h.post('/hw/shifts', cookie, { staffName: '박서연' });
    await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: tab.id });

    const off = nextEvent<AlarmOff>(tab, 'hospital.alarm_off');
    const next = await h.post('/hw/shifts', cookie, { staffName: '김도윤' });
    assert.equal(next.status, 201);
    assert.equal((await off).data.reason, 'shift_ended');
    const { rows } = await h.pool.query(
      'SELECT staff_name, alarm_on_at FROM hospital_shift WHERE ended_at IS NULL',
    );
    assert.deepEqual(rows, [{ staff_name: '김도윤', alarm_on_at: null }]);
  });
});

test('담당자 이름이 비었거나 40자를 넘으면 400, 등록 안 된 PC 는 401', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    for (const staffName of ['  ', '가'.repeat(41)]) {
      const res = await h.post('/hw/shifts', cookie, { staffName });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    }
    const stranger = await h.post('/hw/shifts', 'st_pc=made-up', { staffName: '박서연' });
    assert.equal(stranger.body.error.code, 'PC_NOT_REGISTERED');
  });
});

test('REST로 알림을 켠 탭이 받았음을 안 보내면 DB 알림도 꺼져 다음 요청 대상에서 빠진다 (SFR-161)', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    await h.post('/hw/shifts', cookie, { staffName: '박서연' });
    // 이 탭은 request.new를 받아도 받았음을 보내지 않는다
    const tab = await h.openTab(cookie);
    assert.equal(
      (await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: tab.id })).status,
      200,
    );
    const off = nextEvent<AlarmOff>(tab, 'hospital.alarm_off');

    await addParamedic(h.pool, { loginId: 'kim01' });
    const login = await h
      .api()
      .post('/api/v1/auth/login')
      .send({ loginId: 'kim01', password: TEST_PASSWORD, deviceId: 'd1' });
    const auth = `Bearer ${login.body.tokens.accessToken}`;
    await h.api().post('/api/v1/teams').set('Authorization', auth).send({ role: 'driver' });
    const created = await h
      .api()
      .post('/api/v1/transports')
      .set('Authorization', auth)
      .send({
        id: randomUUID(),
        radiusKm: 20,
        location: { lat: 36.81, lng: 127.1 },
        locationConsent: true,
        assessment: { chiefComplaint: '두통' },
      });
    assert.equal(created.body.status, 'requesting');

    assert.equal((await off).data.reason, 'no_ack');
    await eventually(
      () => alarmOnAt(h.pool),
      (v) => v.length === 1 && v[0] === null,
    );
  });
});
