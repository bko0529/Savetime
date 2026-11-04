// SFR-119·140·153·154·160 인수 기준(승인·거절, 두 PC 동시 응답, 2분, 과승인, 거절 → 제외 병원·예비 추천)을
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
import { addParamedic, withAuthContext } from '../../testing/auth.js';
import { addHospitalWithKey, WEB_ORIGIN } from '../../testing/hospitalWeb.js';
import { TEST_REDIS_URL } from '../../testing/services.js';
import { createRealtime } from '../realtime/server.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

interface Harness {
  pool: pg.Pool;
  // 병원 1곳 + 근무 시작한 PC 1대. 같은 병원에 PC 를 더 붙이려면 key 로 다시 부른다
  hospital: (publicId: string) => Promise<{ id: string; key: string }>;
  register: (key: string, pcName: string) => Promise<string>;
  pcOnShift: (key: string, pcName: string, staffName: string) => Promise<string>;
  post: (path: string, cookie: string, body?: object) => request.Test;
  openTab: (cookie: string) => Promise<ClientSocket>;
}

async function withRespondApp(use: (h: Harness) => Promise<void>): Promise<void> {
  await withAuthContext(async (auth) => {
    const realtime = createRealtime({
      auth,
      redisUrl: TEST_REDIS_URL,
      logger,
      prefix: `t_${randomBytes(6).toString('hex')}`,
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
    const post: Harness['post'] = (path, cookie, body = {}) =>
      request(server)
        .post(`/api/v1${path}`)
        .set('Origin', WEB_ORIGIN)
        .set('Cookie', cookie)
        .send(body);
    const register = async (key: string, pcName: string) => {
      const res = await request(server)
        .post('/api/v1/hw/pc/register')
        .set('Origin', WEB_ORIGIN)
        .send({ licenseKey: key, pcName });
      assert.equal(res.status, 201);
      const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      return header.find((c) => c.startsWith('st_pc='))!.split(';')[0];
    };

    try {
      await use({
        pool: auth.pool,
        hospital: async (publicId) => {
          const { hospitalId, key } = await addHospitalWithKey(auth.pool, {
            publicId,
            name: `${publicId}병원`,
          });
          return { id: hospitalId, key };
        },
        register,
        pcOnShift: async (key, pcName, staffName) => {
          const cookie = await register(key, pcName);
          assert.equal((await post('/hw/shifts', cookie, { staffName })).status, 201);
          return cookie;
        },
        post,
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

let teamSeq = 0;

// 팀의 이송 건 1개 → 1회차 → 병원마다 대기 요청 1개 (대원 앱 '병원에 요청'이 만드는 모양)
async function sendRound(
  pool: pg.Pool,
  hospitalIds: string[],
  { respondIn = '2 minutes', status = 'waiting' } = {},
): Promise<{ transportId: string; teamId: string; requestIds: number[] }> {
  const paramedicId = await addParamedic(pool, { loginId: `p${randomBytes(3).toString('hex')}` });
  const { rows: teams } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ($2, 'qr', $1) RETURNING id`,
    // 활성 팀 코드는 겹치면 안 된다
    [paramedicId, String(1000 + (teamSeq += 1))],
  );
  const transportId = randomUUID();
  await pool.query(`INSERT INTO transport (id, team_id, location_consent) VALUES ($1, $2, true)`, [
    transportId,
    teams[0].id,
  ]);
  await pool.query(
    `INSERT INTO assessment (transport_id, seq, chief_complaint) VALUES ($1, 1, '흉통')`,
    [transportId],
  );
  const { rows: rounds } = await pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() + $2::interval - interval '2 minutes', now() + $2::interval,
             now() + $2::interval + interval '3 minutes') RETURNING id`,
    [transportId, respondIn],
  );
  const requestIds: number[] = [];
  for (const hospitalId of hospitalIds) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO hospital_request (round_id, hospital_id, status, eta_min, eta_source)
       VALUES ($1, $2, $3, 9, 'straight') RETURNING id`,
      [rounds[0].id, hospitalId, status],
    );
    requestIds.push(Number(rows[0].id));
  }
  return { transportId, teamId: teams[0].id, requestIds };
}

async function eventsOf(pool: pg.Pool) {
  const { rows } = await pool.query<{
    room: string;
    name: string;
    payload: Record<string, unknown>;
  }>('SELECT room, name, payload FROM event_log ORDER BY seq');
  return rows;
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

interface Changed {
  data: { requestId: number; status: string; byName: string; pcName: string };
}

test('승인: 담당자·메모를 남기고 팀에 request.approved, 같은 병원 다른 PC 에 request.changed', async () => {
  await withRespondApp(async (h) => {
    const a = await h.hospital('H1');
    const desk = await h.pcOnShift(a.key, '접수대', '박서연');
    const other = await h.pcOnShift(a.key, '처치실', '김도윤');
    const otherTab = await h.openTab(other);
    const {
      transportId,
      teamId,
      requestIds: [id],
    } = await sendRound(h.pool, [a.id]);

    const changed = nextEvent<Changed>(otherTab, 'request.changed');
    const res = await h.post(`/hw/requests/${id}/approve`, desk, {
      version: 1,
      memo: ' 소생실 준비함 ',
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'approved', respondedBy: '박서연', version: 2 });
    const { rows } = await h.pool.query(
      `SELECT hr.status, hr.responder_name, p.name AS pc, hr.memo, hr.responded_at IS NOT NULL AS responded
         FROM hospital_request hr JOIN hospital_pc p ON p.id = hr.responder_pc_id WHERE hr.id = $1`,
      [id],
    );
    assert.deepEqual(rows[0], {
      status: 'approved',
      responder_name: '박서연',
      pc: '접수대',
      memo: '소생실 준비함',
      responded: true,
    });
    const event = (await changed).data;
    assert.deepEqual(event, {
      requestId: id,
      status: 'approved',
      closeReason: null,
      byName: '박서연',
      pcName: '접수대',
    });

    const logged = await eventsOf(h.pool);
    assert.deepEqual(
      logged.map((e) => [e.room, e.name]),
      [
        [`team:${teamId}`, 'request.approved'],
        [`hospital:${a.id}`, 'request.changed'],
      ],
    );
    assert.equal(logged[0].payload.firstApproval, true);
    assert.equal(logged[0].payload.transportId, transportId);
    // 이벤트에 환자 정보는 없다 (규칙 5)
    assert.doesNotMatch(JSON.stringify(logged), /흉통/);
    // 승인만으로는 이송 건이 그대로 '요청 중' (행도 바뀌지 않음)
    const { rows: t } = await h.pool.query('SELECT status, version FROM transport WHERE id = $1', [
      transportId,
    ]);
    assert.deepEqual(t[0], { status: 'requesting', version: 1 });
  });
});

test('두 PC 가 동시에 승인하면 하나만 성공, 나중 PC 는 ALREADY_RESPONDED + 먼저 응답한 사람', async () => {
  await withRespondApp(async (h) => {
    const a = await h.hospital('H1');
    const desk = await h.pcOnShift(a.key, '접수대', '박서연');
    const other = await h.pcOnShift(a.key, '처치실', '김도윤');
    const {
      requestIds: [id],
    } = await sendRound(h.pool, [a.id]);

    const results = await Promise.all([
      h.post(`/hw/requests/${id}/approve`, desk, { version: 1 }),
      h.post(`/hw/requests/${id}/approve`, other, { version: 1 }),
    ]);

    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    const loser = results.find((r) => r.status === 409)!;
    assert.equal(loser.body.error.code, 'ALREADY_RESPONDED');
    assert.equal(loser.body.error.details.respondedBy, winner.body.respondedBy);
    assert.ok(['접수대', '처치실'].includes(loser.body.error.details.pcName));
    const { rows } = await h.pool.query('SELECT version FROM hospital_request WHERE id = $1', [id]);
    assert.equal(rows[0].version, 2);

    // 이미 승인된 요청을 거절해도 마찬가지
    const late = await h.post(`/hw/requests/${id}/reject`, other, { version: 2, reason: 'er_bed' });
    assert.equal(late.body.error.code, 'ALREADY_RESPONDED');
  });
});

test('2분 지남·닫힌 요청·version 빠짐·다른 병원·근무 전은 응답하지 못한다', async () => {
  await withRespondApp(async (h) => {
    const a = await h.hospital('H1');
    const b = await h.hospital('H2');
    const desk = await h.pcOnShift(a.key, '접수대', '박서연');
    const {
      requestIds: [late],
    } = await sendRound(h.pool, [a.id], { respondIn: '-1 second' });
    const {
      requestIds: [closed],
    } = await sendRound(h.pool, [a.id], { status: 'closed' });
    const {
      requestIds: [open, theirs],
    } = await sendRound(h.pool, [a.id, b.id]);

    const expect = async (id: number, body: object, status: number, code: string) => {
      const res = await h.post(`/hw/requests/${id}/approve`, desk, body);
      assert.equal(res.status, status, code);
      assert.equal(res.body.error.code, code);
    };
    await expect(late, { version: 1 }, 409, 'REQUEST_EXPIRED');
    await expect(closed, { version: 1 }, 409, 'REQUEST_CLOSED');
    await expect(open, {}, 400, 'VERSION_REQUIRED');
    await expect(theirs, { version: 1 }, 404, 'NOT_FOUND');

    // 등록만 하고 근무를 시작하지 않은 PC 는 누가 응답했는지 남길 수 없다
    const idle = await h.register(a.key, '처치실');
    const res = await h.post(`/hw/requests/${open}/approve`, idle, { version: 1 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SHIFT_REQUIRED');

    const { rows } = await h.pool.query(
      "SELECT count(*)::int AS n FROM hospital_request WHERE status <> 'waiting' AND id <> $1",
      [closed],
    );
    assert.equal(rows[0].n, 0);
    assert.deepEqual(await eventsOf(h.pool), []);
  });
});

test('과승인: 유효 승인 수가 응급실 가용 병상 이상이면 한 번 더 확인해야 승인된다 (SFR-154)', async () => {
  await withRespondApp(async (h) => {
    const a = await h.hospital('H1');
    const desk = await h.pcOnShift(a.key, '접수대', '박서연');
    await h.pool.query(
      `INSERT INTO bed_current (hospital_id, er_avail, er_total, source_time) VALUES ($1, 1, 20, now())`,
      [a.id],
    );
    const {
      requestIds: [first],
    } = await sendRound(h.pool, [a.id]);
    const {
      requestIds: [second],
    } = await sendRound(h.pool, [a.id]);
    assert.equal((await h.post(`/hw/requests/${first}/approve`, desk, { version: 1 })).status, 200);

    const warned = await h.post(`/hw/requests/${second}/approve`, desk, { version: 1 });
    assert.equal(warned.status, 409);
    assert.equal(warned.body.error.code, 'OVER_APPROVAL_CONFIRM_REQUIRED');
    assert.deepEqual(warned.body.error.details, { validApprovals: 1, erAvail: 1 });

    const confirmed = await h.post(`/hw/requests/${second}/approve`, desk, {
      version: 1,
      overApprovalConfirmed: true,
    });
    assert.equal(confirmed.status, 200);
  });
});

test('거절: 사유 필수, 제외 병원에 추가. 마지막 열린 요청까지 거절되면 이송 건은 예비 추천으로', async () => {
  await withRespondApp(async (h) => {
    const a = await h.hospital('H1');
    const b = await h.hospital('H2');
    const deskA = await h.pcOnShift(a.key, '접수대', '박서연');
    const deskB = await h.pcOnShift(b.key, '접수대', '이하준');
    const {
      transportId,
      teamId,
      requestIds: [idA, idB],
    } = await sendRound(h.pool, [a.id, b.id]);

    for (const body of [{ version: 1 }, { version: 1, reason: 'etc', etcText: '  ' }]) {
      const res = await h.post(`/hw/requests/${idA}/reject`, deskA, body);
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'REASON_REQUIRED');
    }
    const tooLong = await h.post(`/hw/requests/${idA}/reject`, deskA, {
      version: 1,
      reason: 'etc',
      etcText: '가'.repeat(21),
    });
    assert.equal(tooLong.status, 400);

    const first = await h.post(`/hw/requests/${idA}/reject`, deskA, {
      version: 1,
      reason: 'etc',
      etcText: 'MRI 점검',
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { status: 'rejected', version: 2 });
    const { rows: stored } = await h.pool.query(
      'SELECT reason, reason_text, in_stats, responder_name FROM hospital_request WHERE id = $1',
      [idA],
    );
    assert.deepEqual(stored[0], {
      reason: 'etc',
      reason_text: 'MRI 점검',
      in_stats: true,
      responder_name: '박서연',
    });
    // B병원이 아직 대기 중이라 이송 건은 '요청 중' 그대로
    let { rows: t } = await h.pool.query('SELECT status FROM transport WHERE id = $1', [
      transportId,
    ]);
    assert.equal(t[0].status, 'requesting');

    assert.equal(
      (await h.post(`/hw/requests/${idB}/reject`, deskB, { version: 1, reason: 'er_bed' })).status,
      200,
    );
    ({ rows: t } = await h.pool.query(
      'SELECT status, fallback_reason, version FROM transport WHERE id = $1',
      [transportId],
    ));
    assert.deepEqual(t[0], { status: 'fallback', fallback_reason: 'all_rejected', version: 2 });
    const { rows: excluded } = await h.pool.query(
      'SELECT hospital_id::text AS id, reason FROM excluded_hospital WHERE transport_id = $1 ORDER BY hospital_id',
      [transportId],
    );
    assert.deepEqual(excluded, [
      { id: a.id, reason: 'rejected' },
      { id: b.id, reason: 'rejected' },
    ]);

    const teamEvents = (await eventsOf(h.pool)).filter((e) => e.room === `team:${teamId}`);
    assert.deepEqual(
      teamEvents.map((e) => e.name),
      ['request.rejected', 'request.rejected', 'transport.status'],
    );
    assert.equal(teamEvents[0].payload.reason, 'etc');
    assert.deepEqual(teamEvents[2].payload, {
      transportId,
      status: 'fallback',
      event: 'NO_OPEN_REQUEST',
      reason: 'all_rejected',
      byName: null,
    });
  });
});

test('병원 응답은 활동이라 2시간 자동 종료 시계를 다시 시작한다 (SFR-086)', async () => {
  await withRespondApp(async (h) => {
    const a = await h.hospital('H1');
    const desk = await h.pcOnShift(a.key, '접수대', '박서연');
    const {
      transportId,
      requestIds: [id],
    } = await sendRound(h.pool, [a.id]);
    await h.pool.query(
      `UPDATE transport SET last_activity_at = now() - interval '1 hour' WHERE id = $1`,
      [transportId],
    );
    assert.equal((await h.post(`/hw/requests/${id}/approve`, desk, { version: 1 })).status, 200);
    const { rows } = await h.pool.query(
      `SELECT now() - last_activity_at < interval '1 minute' AS fresh, version FROM transport WHERE id = $1`,
      [transportId],
    );
    // 이송 건 상태는 그대로라 version은 오르지 않는다
    assert.deepEqual(rows[0], { fresh: true, version: 1 });
  });
});
