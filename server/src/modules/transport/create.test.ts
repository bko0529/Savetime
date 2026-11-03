// SFR-109 이송 요청 동시 전송 · SFR-104 진행 중 1건 · SFR-133 진행 중 불러오기를 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import type { AuthContext } from '../auth/session.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const ORIGIN = { lat: 36.815, lng: 127.1139 };

function appFor(ctx: AuthContext) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
}

async function login(ctx: AuthContext, loginId: string): Promise<string> {
  await addParamedic(ctx.pool, { loginId });
  const res = await request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  assert.equal(res.status, 200);
  return res.body.tokens.accessToken;
}

// 팀을 만들고 나머지 대원을 참여시킨다. 대원별 접근 토큰을 돌려준다
async function team(ctx: AuthContext, ...loginIds: string[]): Promise<string[]> {
  const tokens = [];
  for (const id of loginIds) tokens.push(await login(ctx, id));
  const created = await request(appFor(ctx))
    .post('/api/v1/teams')
    .set('Authorization', `Bearer ${tokens[0]}`)
    .send({ role: 'driver' });
  for (const t of tokens.slice(1)) {
    await request(appFor(ctx))
      .post('/api/v1/teams/join')
      .set('Authorization', `Bearer ${t}`)
      .send({ code: created.body.code, role: 'care' });
  }
  return tokens;
}

interface HospitalOpts {
  dLat: number; // 출발점에서 북쪽으로 (0.01도 ≈ 1.1km)
  grade?: number;
  alarmOn?: boolean;
  paused?: boolean;
  active?: boolean;
}

async function addHospital(pool: pg.Pool, name: string, opts: HospitalOpts): Promise<string> {
  const { alarmOn = true, paused = false, active = true, grade = 3 } = opts;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, grade, requests_paused, account_active)
     VALUES ($1, $1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, ORIGIN.lat + opts.dLat, ORIGIN.lng, grade, paused, active],
  );
  const { rows: pc } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, '접수대', $2) RETURNING id`,
    [rows[0].id, randomUUID()],
  );
  await pool.query(
    `INSERT INTO hospital_shift (pc_id, staff_name, alarm_on_at) VALUES ($1, '담당자', $2)`,
    [pc[0].id, alarmOn ? new Date() : null],
  );
  return rows[0].id;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    radiusKm: 20,
    location: ORIGIN,
    locationConsent: true,
    assessment: { chiefComplaint: '갑작스러운 두통', sex: 'M', ageBand: '60s', pulse: 110 },
    ...overrides,
  };
}

const post = (ctx: AuthContext, token: string, payload: object) =>
  request(appFor(ctx))
    .post('/api/v1/transports')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);
const current = (ctx: AuthContext, token: string) =>
  request(appFor(ctx)).get('/api/v1/transports/current').set('Authorization', `Bearer ${token}`);

test('반경 안·알림 켬·요청 중지 아님·계정 활성·고른 등급 이상인 병원에만 요청한다', async () => {
  await withAuthContext(async (ctx) => {
    const [kim] = await team(ctx, 'kim01');
    await addHospital(ctx.pool, 'A병원', { dLat: 0.02, grade: 1 }); // 2.2km
    await addHospital(ctx.pool, 'B병원', { dLat: 0.1, grade: 2 }); // 11km
    await addHospital(ctx.pool, '등급미달', { dLat: 0.03, grade: 3 });
    await addHospital(ctx.pool, '알림꺼짐', { dLat: 0.03, grade: 1, alarmOn: false });
    await addHospital(ctx.pool, '요청중지', { dLat: 0.03, grade: 1, paused: true });
    await addHospital(ctx.pool, '계정없음', { dLat: 0.03, grade: 1, active: false });
    await addHospital(ctx.pool, '반경밖', { dLat: 0.25, grade: 1 }); // 28km

    const res = await post(ctx, kim, body({ requestedGrade: 2 }));
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'requesting');
    assert.equal(res.body.version, 1);
    assert.equal(res.body.requestRadiusKm, 20);
    assert.equal(res.body.fallbackRadiusKm, 20);
    assert.equal(res.body.requestedGrade, 2);
    assert.equal(res.body.currentRound.roundNo, 1);
    assert.equal(res.body.currentRound.kind, 'first');
    assert.equal(res.body.currentRound.targetCount, 2);
    assert.equal(res.body.currentRound.deliveredCount, 0);

    // 직선거리 ÷ 40km/h를 올림한 분 (SFR-129), 가까운 순
    assert.deepEqual(
      res.body.requests.map(
        (r: { hospitalName: string; status: string; etaMin: number; etaSource: string }) => [
          r.hospitalName,
          r.status,
          r.etaMin,
          r.etaSource,
        ],
      ),
      [
        ['A병원', 'waiting', 4, 'straight'],
        ['B병원', 'waiting', 17, 'straight'],
      ],
    );

    // 2분·5분은 DB 시각 기준으로 회차에 고정된다
    const { rows } = await ctx.pool.query(
      `SELECT extract(epoch FROM respond_until - sent_at)::int AS respond,
              extract(epoch FROM approval_valid_until - sent_at)::int AS valid
         FROM request_round`,
    );
    assert.deepEqual(rows[0], { respond: 120, valid: 300 });
  });
});

test('상태 이력·환자 평가·실시간 이벤트를 남기고, 이벤트에는 환자 정보가 없다', async () => {
  await withAuthContext(async (ctx) => {
    const [kim] = await team(ctx, 'kim01');
    await addHospital(ctx.pool, 'A병원', { dLat: 0.02 });
    const payload = body();
    await post(ctx, kim, payload);

    const { rows: history } = await ctx.pool.query(
      'SELECT from_status, to_status, event FROM transport_status_history',
    );
    assert.deepEqual(history, [
      { from_status: null, to_status: 'requesting', event: 'CREATE_WITH_TARGETS' },
    ]);

    const { rows: assessment } = await ctx.pool.query(
      'SELECT seq, chief_complaint, sex, pulse FROM assessment WHERE transport_id = $1',
      [payload.id],
    );
    assert.deepEqual(assessment, [
      { seq: 1, chief_complaint: '갑작스러운 두통', sex: 'M', pulse: 110 },
    ]);

    const { rows: events } = await ctx.pool.query(
      'SELECT room, name, payload FROM event_log ORDER BY seq',
    );
    assert.deepEqual(
      events.map((e) => e.name),
      ['transport.created', 'round.started'],
    );
    assert.ok(events.every((e) => /^team:\d+$/.test(e.room)));
    assert.equal(events[1].payload.targetCount, 1);
    assert.ok(!JSON.stringify(events).includes('두통'));
  });
});

test('요청할 병원이 0곳이면 오류가 아니라 201 + 예비 추천(no_target)이다', async () => {
  await withAuthContext(async (ctx) => {
    const [kim] = await team(ctx, 'kim01');
    await addHospital(ctx.pool, '알림꺼짐', { dLat: 0.02, alarmOn: false });
    const res = await post(ctx, kim, body());
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'fallback');
    assert.equal(res.body.fallbackReason, 'no_target');
    assert.equal(res.body.currentRound, null);
    assert.deepEqual(res.body.requests, []);

    const { rows } = await ctx.pool.query('SELECT name FROM event_log');
    assert.deepEqual(rows, [{ name: 'transport.created' }]);
  });
});

test('같은 id로 다시 보내면 새로 만들지 않고 처음 결과를 돌려준다', async () => {
  await withAuthContext(async (ctx) => {
    const [kim] = await team(ctx, 'kim01');
    await addHospital(ctx.pool, 'A병원', { dLat: 0.02 });
    const payload = body();
    const first = await post(ctx, kim, payload);
    const again = await post(ctx, kim, payload);
    assert.equal(again.status, 201);
    assert.equal(again.body.id, first.body.id);
    assert.deepEqual(again.body.requests, first.body.requests);

    const { rows } = await ctx.pool.query(
      `SELECT (SELECT count(*)::int FROM transport) AS t, (SELECT count(*)::int FROM hospital_request) AS r`,
    );
    assert.deepEqual(rows[0], { t: 1, r: 1 });
  });
});

test('팀에 진행 중 건이 있으면 409와 그 건을 알려 준다', async () => {
  await withAuthContext(async (ctx) => {
    const [kim, lee] = await team(ctx, 'kim01', 'lee01');
    const first = await post(ctx, kim, body());
    const res = await post(ctx, lee, body());
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ACTIVE_TRANSPORT_EXISTS');
    assert.equal(res.body.error.details.activeTransport.id, first.body.id);
    assert.equal(res.body.error.details.activeTransport.status, 'fallback');

    // '이전 이송 끝내기'는 이동 중일 때만 된다
    const finish = await post(ctx, lee, body({ finishPrevious: true, previousVersion: 1 }));
    assert.equal(finish.body.error.code, 'ACTIVE_TRANSPORT_EXISTS');
  });
});

test('두 팀원이 동시에 요청해도 이송 건은 1개만 생긴다', async () => {
  await withAuthContext(async (ctx) => {
    const [kim, lee] = await team(ctx, 'kim01', 'lee01');
    await addHospital(ctx.pool, 'A병원', { dLat: 0.02 });
    const results = await Promise.all([post(ctx, kim, body()), post(ctx, lee, body())]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM transport');
    assert.equal(rows[0].n, 1);
  });
});

test('이동 중인 이전 건은 확인(finishPrevious)과 version이 있어야 도착으로 끝내고 새로 만든다', async () => {
  await withAuthContext(async (ctx) => {
    const [kim] = await team(ctx, 'kim01');
    const hospital = await addHospital(ctx.pool, 'A병원', { dLat: 0.02 });
    const prev = await post(ctx, kim, body());
    // 확정까지는 S3 다음 묶음에서 API로 한다. 여기서는 이동 중 상태를 직접 만든다
    await ctx.pool.query(
      `UPDATE transport SET status = 'moving', confirmed_hospital_id = $2, version = 3 WHERE id = $1`,
      [prev.body.id, hospital],
    );
    await ctx.pool.query(`UPDATE hospital_request SET status = 'confirmed'`);

    const noVersion = await post(ctx, kim, body({ finishPrevious: true }));
    assert.equal(noVersion.status, 400);
    assert.equal(noVersion.body.error.code, 'VERSION_REQUIRED');
    const stale = await post(ctx, kim, body({ finishPrevious: true, previousVersion: 2 }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

    const res = await post(ctx, kim, body({ finishPrevious: true, previousVersion: 3 }));
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'requesting');

    const { rows } = await ctx.pool.query(
      `SELECT t.status, t.arrival_method, t.version, hr.status AS request_status, hr.arrived_at IS NOT NULL AS arrived
         FROM transport t JOIN request_round r ON r.transport_id = t.id
         JOIN hospital_request hr ON hr.round_id = r.id WHERE t.id = $1`,
      [prev.body.id],
    );
    assert.deepEqual(rows[0], {
      status: 'arrived',
      arrival_method: 'finish_previous',
      version: 4,
      request_status: 'arrived',
      arrived: true,
    });
    const { rows: events } = await ctx.pool.query('SELECT name FROM event_log ORDER BY seq');
    assert.deepEqual(events.map((e) => e.name).slice(-3), [
      'transport.arrived',
      'transport.created',
      'round.started',
    ]);
  });
});

test('팀이 없거나 주 증상이 비었거나 위치가 없거나 정해지지 않은 칸이 오면 만들지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const solo = await login(ctx, 'solo01');
    assert.equal((await post(ctx, solo, body())).body.error.code, 'NOT_IN_TEAM');

    const [kim] = await team(ctx, 'kim01');
    const blank = await post(ctx, kim, body({ assessment: { chiefComplaint: '  ' } }));
    assert.equal(blank.status, 422);
    assert.equal(blank.body.error.code, 'ASSESSMENT_INCOMPLETE');

    const noLocation = await post(
      ctx,
      kim,
      body({ location: null, locationConsent: false, address: '천안시' }),
    );
    assert.equal(noLocation.status, 409);
    assert.equal(noLocation.body.error.code, 'LOCATION_REQUIRED');

    // 환자 이름 같은 칸은 받지 않는다 (SER-012). 오류에도 값은 돌려주지 않는다
    const named = await post(
      ctx,
      kim,
      body({ assessment: { chiefComplaint: '두통', name: '홍길동' } }),
    );
    assert.equal(named.status, 400);
    assert.equal(named.body.error.code, 'VALIDATION_FAILED');
    assert.ok(!JSON.stringify(named.body).includes('홍길동'));

    assert.equal((await post(ctx, kim, body({ radiusKm: 15 }))).status, 400);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM transport');
    assert.equal(rows[0].n, 0);
  });
});

test('진행 중 이송 불러오기: 없으면 404, 있으면 팀원 누구나 같은 건을 받는다', async () => {
  await withAuthContext(async (ctx) => {
    const [kim, lee] = await team(ctx, 'kim01', 'lee01');
    const none = await current(ctx, kim);
    assert.equal(none.status, 404);
    assert.equal(none.body.error.code, 'NO_ACTIVE_TRANSPORT');

    await addHospital(ctx.pool, 'A병원', { dLat: 0.02 });
    const created = await post(ctx, kim, body());
    const seen = await current(ctx, lee);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.id, created.body.id);
    assert.equal(seen.body.requests.length, 1);
    assert.ok(seen.body.serverNow);

    // 다른 팀은 이 건을 볼 수 없다
    const [other] = await team(ctx, 'park01');
    assert.equal((await current(ctx, other)).status, 404);
  });
});
