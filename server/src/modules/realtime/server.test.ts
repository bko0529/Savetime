// 실시간 서버(설계 2~4장)와 요청 전달 확인(SFR-161)을 실제 소켓 클라이언트·임시 DB·실제 Redis로 확인한다.
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
import { TEST_REDIS_URL } from '../../testing/services.js';
import type { AuthContext } from '../auth/session.js';
import { hashPcToken } from '../hospital-web/pcAuth.js';
import { createRealtime } from './server.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const ORIGIN = { lat: 36.815, lng: 127.1139 };
// 테스트는 5초 대신 짧게 기다린다
const DELIVERY_MS = 600;

interface Harness {
  ctx: AuthContext;
  app: ReturnType<typeof createApp>;
  connect: (ns: '/app' | '/hospital', opts: object) => Promise<ClientSocket>;
  realtime: ReturnType<typeof createRealtime>;
}

async function withRealtime(use: (h: Harness) => Promise<void>): Promise<void> {
  await withAuthContext(async (ctx) => {
    const realtime = createRealtime({
      auth: ctx,
      redisUrl: TEST_REDIS_URL,
      logger,
      deliveryTimeoutMs: DELIVERY_MS,
      prefix: `t_${randomBytes(6).toString('hex')}`,
    });
    const app = createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx, realtime });
    const server = http.createServer(app);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const clients: ClientSocket[] = [];

    const connect = (ns: string, opts: object) =>
      new Promise<ClientSocket>((resolve, reject) => {
        const socket = connectClient(`${url}${ns}`, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          ...opts,
        });
        clients.push(socket);
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', (err) => reject(err));
      });
    try {
      await use({ ctx, app, connect, realtime });
    } finally {
      for (const c of clients) c.disconnect();
      await realtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

function nextEvent<T = { seq: number; data: Record<string, unknown> }>(
  socket: ClientSocket,
  name: string,
  ms = 4000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}이(가) 오지 않았어요`)), ms);
    socket.once(name, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// DB 값이 바뀔 때까지 잠깐씩 다시 본다
async function eventually<T>(read: () => Promise<T>, check: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 40; i += 1) {
    const value = await read();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('기다린 값이 되지 않았어요');
}

async function login(h: Harness, loginId: string): Promise<string> {
  await addParamedic(h.ctx.pool, { loginId });
  const res = await request(h.app)
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  return res.body.tokens.accessToken;
}

async function makeTeam(h: Harness, token: string): Promise<string> {
  const res = await request(h.app)
    .post('/api/v1/teams')
    .set('Authorization', `Bearer ${token}`)
    .send({ role: 'driver' });
  return res.body.code;
}

function joinTeam(h: Harness, token: string, code: string) {
  return request(h.app)
    .post('/api/v1/teams/join')
    .set('Authorization', `Bearer ${token}`)
    .send({ code, role: 'care' });
}

function postTransport(h: Harness, token: string) {
  return request(h.app)
    .post('/api/v1/transports')
    .set('Authorization', `Bearer ${token}`)
    .send({
      id: randomUUID(),
      radiusKm: 20,
      location: ORIGIN,
      locationConsent: true,
      assessment: { chiefComplaint: '갑작스러운 두통' },
    });
}

// 알림을 켠 근무가 있는 병원 PC 1대. token은 브라우저 쿠키 st_pc 값
async function addHospitalPc(pool: pg.Pool, name: string, dLat = 0.02) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, account_active)
     VALUES ($1, $1, $2, $3, true) RETURNING id`,
    [name, ORIGIN.lat + dLat, ORIGIN.lng],
  );
  const token = randomBytes(24).toString('base64url');
  const { rows: pc } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, '접수대', $2) RETURNING id`,
    [rows[0].id, hashPcToken(token)],
  );
  const { rows: shift } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_shift (pc_id, staff_name, alarm_on_at) VALUES ($1, '박서연', now()) RETURNING id`,
    [pc[0].id],
  );
  return { hospitalId: Number(rows[0].id), shiftId: Number(shift[0].id), token };
}

const asCookie = (token: string) => ({ extraHeaders: { cookie: `st_pc=${token}` } });

test('/app: 토큰이 없거나 틀리면 연결을 거절하고, 맞으면 붙는다', async () => {
  await withRealtime(async (h) => {
    await assert.rejects(h.connect('/app', {}), { message: 'TOKEN_REVOKED' });
    await assert.rejects(h.connect('/app', { auth: { token: 'nope' } }), {
      message: 'TOKEN_REVOKED',
    });
    const token = await login(h, 'kim01');
    const socket = await h.connect('/app', { auth: { token } });
    assert.ok(socket.connected);
  });
});

test('팀원 앱은 커밋된 이송 건 이벤트를 받고, 실패한 요청의 이벤트는 받지 않는다', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    const lee = await login(h, 'lee01');
    await joinTeam(h, lee, await makeTeam(h, kim));
    const leeSocket = await h.connect('/app', { auth: { token: lee } });

    const created = nextEvent(leeSocket, 'transport.created');
    assert.equal((await postTransport(h, kim)).status, 201);
    const event = await created;
    assert.equal(event.data.status, 'fallback');
    assert.equal(event.data.byName, '김도윤');
    assert.ok(event.seq > 0);

    // 진행 중 건이 있어 409로 롤백된 요청은 아무 이벤트도 내보내지 않는다
    let extra = 0;
    leeSocket.onAny(() => (extra += 1));
    assert.equal((await postTransport(h, kim)).status, 409);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(extra, 0);
  });
});

test('팀을 만든 뒤에 붙인 소켓도 팀 방에 들어간다 (이미 연결된 소켓은 팀 참여 때 넣음)', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    const lee = await login(h, 'lee01');
    const leeSocket = await h.connect('/app', { auth: { token: lee } });
    const code = await makeTeam(h, kim);
    await joinTeam(h, lee, code);
    const created = nextEvent(leeSocket, 'transport.created');
    await postTransport(h, kim);
    assert.equal((await created).data.status, 'fallback');
  });
});

test('sync: 놓친 이벤트만 순서대로 다시 보내고, 처음이면 전체를 다시 받게 하고, 팀에 들어오기 전 것은 빼고', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    const lee = await login(h, 'lee01');
    const code = await makeTeam(h, kim);
    await postTransport(h, kim);
    // 이하준은 이송 건이 생긴 뒤에 팀에 들어왔다
    await joinTeam(h, lee, code);

    const kimSocket = await h.connect('/app', { auth: { token: kim } });
    const replayed: string[] = [];
    kimSocket.onAny((name: string) => replayed.push(name));
    const first = await kimSocket.emitWithAck('sync', { lastSeq: null });
    assert.equal(first.snapshotRequired, true);
    assert.equal(first.replayed, 0);

    const again = await kimSocket.emitWithAck('sync', { lastSeq: 0 });
    assert.equal(again.snapshotRequired, false);
    assert.equal(again.replayed, 1);
    assert.deepEqual(replayed, ['transport.created']);
    assert.ok(again.latestSeq >= 1);

    const leeSocket = await h.connect('/app', { auth: { token: lee } });
    const leeSync = await leeSocket.emitWithAck('sync', { lastSeq: 0 });
    assert.equal(leeSync.replayed, 0);
  });
});

test('/hospital: 등록 안 된 PC는 거절하고, 다른 PC의 근무로는 알림을 되살리지 못한다', async () => {
  await withRealtime(async (h) => {
    await assert.rejects(h.connect('/hospital', {}), { message: 'PC_NOT_REGISTERED' });
    await assert.rejects(h.connect('/hospital', asCookie('fake')), {
      message: 'PC_NOT_REGISTERED',
    });
    const a = await addHospitalPc(h.ctx.pool, 'A병원');
    const b = await addHospitalPc(h.ctx.pool, 'B병원');
    const socket = await h.connect('/hospital', asCookie(a.token));
    assert.deepEqual(await socket.emitWithAck('alarm.resume', { shiftId: b.shiftId }), {
      ok: false,
    });
    assert.deepEqual(await socket.emitWithAck('alarm.resume', { shiftId: a.shiftId }), {
      ok: true,
    });
  });
});

test('알림 켠 PC가 받았음을 보내면 전달 1곳으로 세고 요청 중을 유지한다 (SFR-161)', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    await makeTeam(h, kim);
    const app = await h.connect('/app', { auth: { token: kim } });
    const pc = await addHospitalPc(h.ctx.pool, 'A병원');
    const hospital = await h.connect('/hospital', asCookie(pc.token));
    await hospital.emitWithAck('alarm.resume', { shiftId: pc.shiftId });

    const received = new Promise<{ data: Record<string, unknown> }>((resolve) => {
      hospital.on('request.new', (e, ack: (r: { received: true }) => void) => {
        ack({ received: true });
        resolve(e);
      });
    });
    const delivered = nextEvent(app, 'request.delivered');
    const res = await postTransport(h, kim);
    assert.equal(res.body.status, 'requesting');

    const e = await received;
    assert.equal(e.data.requestId, res.body.requests[0].id);
    // 환자 정보 없이 고정 문구만 (SER-014)
    assert.equal(e.data.label, '새 이송 요청');

    const result = await delivered;
    assert.deepEqual(result.data, {
      transportId: res.body.id,
      roundNo: 1,
      deliveredCount: 1,
      failedHospitalIds: [],
      final: true,
    });
    const { rows } = await h.ctx.pool.query(
      `SELECT hr.status, hr.delivered_at IS NOT NULL AS delivered, t.status AS transport
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
         JOIN transport t ON t.id = r.transport_id`,
    );
    assert.deepEqual(rows, [{ status: 'waiting', delivered: true, transport: 'requesting' }]);
  });
});

test('받았음이 없으면 전달 실패로 닫고 그 PC 알림을 끄며, 전달 0곳이면 예비 추천으로 바꾼다', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    await makeTeam(h, kim);
    const app = await h.connect('/app', { auth: { token: kim } });
    const pc = await addHospitalPc(h.ctx.pool, 'A병원');
    // 이 PC는 request.new를 받아도 받았음을 보내지 않는다
    const hospital = await h.connect('/hospital', asCookie(pc.token));
    await hospital.emitWithAck('alarm.resume', { shiftId: pc.shiftId });

    const alarmOff = nextEvent(hospital, 'hospital.alarm_off');
    const delivered = nextEvent(app, 'request.delivered');
    const status = nextEvent(app, 'transport.status');
    const res = await postTransport(h, kim);

    assert.deepEqual((await alarmOff).data, { reason: 'no_ack' });
    assert.deepEqual((await delivered).data.failedHospitalIds, [pc.hospitalId]);
    const changed = await status;
    assert.equal(changed.data.status, 'fallback');
    assert.equal(changed.data.reason, 'none_delivered');

    const { rows } = await h.ctx.pool.query(
      `SELECT t.status, t.fallback_reason, t.version, hr.status AS request,
              (SELECT alarm_on_at FROM hospital_shift WHERE id = $2) AS alarm
         FROM transport t JOIN request_round r ON r.transport_id = t.id
         JOIN hospital_request hr ON hr.round_id = r.id WHERE t.id = $1`,
      [res.body.id, pc.shiftId],
    );
    assert.deepEqual(rows[0], {
      status: 'fallback',
      fallback_reason: 'none_delivered',
      version: 2,
      request: 'delivery_failed',
      alarm: null,
    });
    const { rows: history } = await h.ctx.pool.query(
      'SELECT event, reason FROM transport_status_history WHERE transport_id = $1 ORDER BY id',
      [res.body.id],
    );
    assert.deepEqual(history.at(-1), { event: 'NO_OPEN_REQUEST', reason: 'none_delivered' });
  });
});

test('두 병원 중 한 곳만 받으면 요청 중을 유지하고 받지 못한 병원만 전달 실패다', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    await makeTeam(h, kim);
    const app = await h.connect('/app', { auth: { token: kim } });
    const a = await addHospitalPc(h.ctx.pool, 'A병원', 0.02);
    // B병원은 DB에는 알림이 켜져 있지만 서버가 꺼진 사이 브라우저가 닫혀 소켓이 없다
    const b = await addHospitalPc(h.ctx.pool, 'B병원', 0.04);
    const hospital = await h.connect('/hospital', asCookie(a.token));
    await hospital.emitWithAck('alarm.resume', { shiftId: a.shiftId });
    hospital.on('request.new', (_e, ack: (r: { received: true }) => void) =>
      ack({ received: true }),
    );

    const delivered = nextEvent(app, 'request.delivered');
    const res = await postTransport(h, kim);
    const result = await delivered;
    assert.equal(result.data.deliveredCount, 1);
    assert.deepEqual(result.data.failedHospitalIds, [b.hospitalId]);

    const { rows } = await h.ctx.pool.query(
      `SELECT h.name, hr.status FROM hospital_request hr JOIN hospital h ON h.id = hr.hospital_id
        ORDER BY h.name`,
    );
    assert.deepEqual(rows, [
      { name: 'A병원', status: 'waiting' },
      { name: 'B병원', status: 'delivery_failed' },
    ]);
    const current = await request(h.app)
      .get('/api/v1/transports/current')
      .set('Authorization', `Bearer ${kim}`);
    assert.equal(current.body.id, res.body.id);
    assert.equal(current.body.status, 'requesting');
    assert.equal(current.body.currentRound.deliveredCount, 1);
    assert.equal(current.body.currentRound.deliveryFinal, true);
  });
});

test('병원 PC 연결이 끊기면 알림이 꺼져 다음 요청 대상에서 빠진다 (SFR-117)', async () => {
  await withRealtime(async (h) => {
    const pc = await addHospitalPc(h.ctx.pool, 'A병원');
    const hospital = await h.connect('/hospital', asCookie(pc.token));
    await hospital.emitWithAck('alarm.resume', { shiftId: pc.shiftId });
    hospital.disconnect();
    await eventually(
      async () =>
        (
          await h.ctx.pool.query('SELECT alarm_on_at FROM hospital_shift WHERE id = $1', [
            pc.shiftId,
          ])
        ).rows[0].alarm_on_at,
      (v) => v === null,
    );

    const kim = await login(h, 'kim01');
    await makeTeam(h, kim);
    const res = await postTransport(h, kim);
    assert.equal(res.body.status, 'fallback');
    assert.equal(res.body.fallbackReason, 'no_target');
  });
});

test('근무 종료하면 그 대원의 실시간 연결도 끊긴다 (SER-016)', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    await makeTeam(h, kim);
    const socket = await h.connect('/app', { auth: { token: kim } });
    const closed = new Promise((resolve) => socket.once('disconnect', resolve));
    await request(h.app).post('/api/v1/teams/current/leave').set('Authorization', `Bearer ${kim}`);
    await closed;
    await assert.rejects(h.connect('/app', { auth: { token: kim } }), {
      message: 'TOKEN_REVOKED',
    });
  });
});

test('서버가 다시 켜지면 판정이 안 끝난 회차를 DB에서 찾아 전달 확인을 다시 건다', async () => {
  await withAuthContext(async (ctx) => {
    // 서버가 꺼지기 직전에 보낸 요청: 받았음 없이 대기 중
    const { hospitalId } = await addHospitalPc(ctx.pool, 'A병원');
    const transportId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO transport (id, status, location_consent) VALUES ($1, 'requesting', true)`,
      [transportId],
    );
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
       VALUES ($1, 1, 20, now() - interval '3 seconds', now() + interval '2 minutes', now() + interval '5 minutes')
       RETURNING id`,
      [transportId],
    );
    await ctx.pool.query(`INSERT INTO hospital_request (round_id, hospital_id) VALUES ($1, $2)`, [
      rows[0].id,
      hospitalId,
    ]);

    const realtime = createRealtime({
      auth: ctx,
      redisUrl: TEST_REDIS_URL,
      logger,
      deliveryTimeoutMs: DELIVERY_MS,
      prefix: `t_${randomBytes(6).toString('hex')}`,
    });
    try {
      const status = await eventually(
        async () =>
          (await ctx.pool.query('SELECT status FROM transport WHERE id = $1', [transportId]))
            .rows[0].status,
        (v) => v === 'fallback',
      );
      assert.equal(status, 'fallback');
      const { rows: requests } = await ctx.pool.query('SELECT status FROM hospital_request');
      assert.deepEqual(requests, [{ status: 'delivery_failed' }]);
    } finally {
      await realtime.close();
    }
  });
});

test('병원 계정을 정지하면 그 병원 탭에만 pc.revoked를 보내고 연결을 끊는다 (SFR-123)', async () => {
  await withRealtime(async (h) => {
    const a = await addHospitalPc(h.ctx.pool, 'A병원');
    const b = await addHospitalPc(h.ctx.pool, 'B병원', 0.04);
    const aTab = await h.connect('/hospital', asCookie(a.token));
    const bTab = await h.connect('/hospital', asCookie(b.token));

    const revoked = nextEvent(aTab, 'pc.revoked');
    const closed = new Promise((resolve) => aTab.once('disconnect', resolve));
    let bRevoked = false;
    bTab.on('pc.revoked', () => (bRevoked = true));

    await h.realtime.revokeHospital(String(a.hospitalId), 'account_suspended');
    assert.deepEqual((await revoked).data, { reason: 'account_suspended' });
    await closed;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(bRevoked, false);
    assert.ok(bTab.connected);
  });
});

// 회차를 직접 만든다 (마감을 짧게 잡으려고). 병원 요청은 이미 받았음 처리돼 있다
async function addRound(h: Harness, token: string, hospitalId: number, respondIn: string) {
  const team = await request(h.app)
    .get('/api/v1/teams/current')
    .set('Authorization', `Bearer ${token}`);
  const transportId = randomUUID();
  await h.ctx.pool.query(
    `INSERT INTO transport (id, team_id, status, location_consent) VALUES ($1, $2, 'requesting', true)`,
    [transportId, team.body.id],
  );
  const { rows } = await h.ctx.pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() + $2::interval, now() + interval '5 minutes') RETURNING id`,
    [transportId, respondIn],
  );
  await h.ctx.pool.query(
    `INSERT INTO hospital_request (round_id, hospital_id, delivered_at) VALUES ($1, $2, now())`,
    [rows[0].id, hospitalId],
  );
  return { transportId, roundId: rows[0].id };
}

test('2분 타이머: 마감이 되면 팀에 request.expired·transport.status, 병원 탭에 request.changed가 간다 (SFR-124·112)', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    await makeTeam(h, kim);
    const app = await h.connect('/app', { auth: { token: kim } });
    const pc = await addHospitalPc(h.ctx.pool, 'A병원');
    const tab = await h.connect('/hospital', asCookie(pc.token));
    await tab.emitWithAck('alarm.resume', { shiftId: pc.shiftId });
    tab.on('request.new', (_e, ack: (r: { received: true }) => void) => ack({ received: true }));

    const expired = nextEvent(app, 'request.expired');
    const status = nextEvent(app, 'transport.status');
    const changed = nextEvent(tab, 'request.changed');
    const round = await addRound(h, kim, pc.hospitalId, '800 milliseconds');
    h.realtime.startRound(round.roundId);

    assert.deepEqual((await expired).data, {
      transportId: round.transportId,
      roundNo: 1,
      anyApproved: false,
    });
    assert.equal((await status).data.reason, 'expired_no_approval');
    assert.equal((await changed).data.status, 'expired');
  });
});

test('서버가 다시 켜지면 마감이 지난 회차를 DB에서 찾아 만료 처리한다', async () => {
  await withRealtime(async (h) => {
    const kim = await login(h, 'kim01');
    await makeTeam(h, kim);
    const pc = await addHospitalPc(h.ctx.pool, 'A병원');
    const round = await addRound(h, kim, pc.hospitalId, '-5 seconds');

    // 같은 DB에 서버를 하나 더 켠 것처럼
    const restarted = createRealtime({
      auth: h.ctx,
      redisUrl: TEST_REDIS_URL,
      logger,
      deliveryTimeoutMs: DELIVERY_MS,
      prefix: `t_${randomBytes(6).toString('hex')}`,
    });
    try {
      await eventually(
        async () =>
          (
            await h.ctx.pool.query('SELECT status FROM transport WHERE id = $1', [
              round.transportId,
            ])
          ).rows[0].status,
        (v) => v === 'fallback',
      );
    } finally {
      await restarted.close();
    }
  });
});
