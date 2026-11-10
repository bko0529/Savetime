// SFR-151(대원 계정 정지·해제) 인수 기준을 임시 DB·실제 Redis 에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import { WEB_ORIGIN } from '../../testing/hospitalWeb.js';
import type { LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { signAdminAccessToken } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

interface Harness {
  pool: pg.Pool;
  admin: (method: 'get' | 'post', path: string) => request.Test;
  // 대원 앱 쪽 요청
  app: () => ReturnType<typeof request>;
  // 실시간 서버 대신: 강제 로그아웃한 대원 id, 보낸 이벤트
  forcedOut: string[];
  published: LoggedEvent[];
}

async function withAdminParamedics(use: (h: Harness) => Promise<void>): Promise<void> {
  await withAuthContext(async (ctx) => {
    const forcedOut: string[] = [];
    const published: LoggedEvent[] = [];
    const realtime = {
      publish: (events: LoggedEvent[]) => published.push(...events),
      forceLogoutParamedic: async (id: string) => {
        forcedOut.push(id);
      },
      disconnectParamedic: async () => {},
    } as unknown as Realtime;
    const server = createApp({
      logger,
      healthChecks: { db: ok, redis: ok },
      auth: ctx,
      realtime,
      admin: {
        pool: ctx.pool,
        redis: ctx.redis,
        jwtKey: ctx.jwtKey,
        sessionHours: 14,
        allowedOrigins: [WEB_ORIGIN],
      },
    });
    const { rows } = await ctx.pool.query<{ id: string }>(
      "INSERT INTO admin (login_id, password_hash, name) VALUES ('kim', 'x', '김관리') RETURNING id",
    );
    const adminToken = await signAdminAccessToken(ctx.jwtKey, rows[0].id);
    await use({
      pool: ctx.pool,
      forcedOut,
      published,
      app: () => request(server),
      admin: (method, path) =>
        request(server)
          [method](`/api/v1${path}`)
          .set('Origin', WEB_ORIGIN)
          .set('Authorization', `Bearer ${adminToken}`),
    });
  });
}

async function login(h: Harness, loginId: string) {
  return h
    .app()
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
}

// 팀을 만들고, 이동 중 이송 건 1개를 붙인다
async function movingTeam(pool: pg.Pool, memberIds: string[]) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ('4821', 'qr', $1) RETURNING id`,
    [memberIds[0]],
  );
  const teamId = rows[0].id;
  for (const [i, id] of memberIds.entries()) {
    await pool.query('INSERT INTO team_member (team_id, paramedic_id, role) VALUES ($1, $2, $3)', [
      teamId,
      id,
      i === 0 ? 'driver' : 'care',
    ]);
  }
  const { rows: h } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng) VALUES ('B1', 'B병원', 36.8, 127.1) RETURNING id`,
  );
  const transportId = randomUUID();
  await pool.query(
    `INSERT INTO transport (id, team_id, status, location_consent, confirmed_hospital_id)
     VALUES ($1, $2, 'moving', true, $3)`,
    [transportId, teamId, h[0].id],
  );
  return { teamId, transportId };
}

const transportStatus = async (pool: pg.Pool, id: string) =>
  (
    await pool.query<{ status: string; cancel_reason: string | null }>(
      `SELECT t.status, (SELECT reason FROM transport_status_history
                          WHERE transport_id = t.id ORDER BY at DESC LIMIT 1) AS cancel_reason
         FROM transport t WHERE id = $1`,
      [id],
    )
  ).rows[0];

test("김도윤을 '폰 분실'로 정지하면 앱이 로그아웃되고, 다시 로그인하면 정지 안내가 나오고, 작업 이력에 1건 (SFR-151 인수 기준)", async () => {
  await withAdminParamedics(async (h) => {
    const id = await addParamedic(h.pool, { loginId: 'kim01' });
    const { accessToken } = (await login(h, 'kim01')).body.tokens;
    assert.equal(
      (await h.app().get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`)).status,
      200,
    );

    const res = await h
      .admin('post', `/admin/paramedics/${id}/suspend`)
      .send({ reason: 'phone_lost' });
    assert.equal(res.status, 204);

    // 이미 받은 접근 토큰도 바로 막힌다 (SER-016)
    const me = await h.app().get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
    assert.equal(me.status, 401);
    assert.deepEqual(h.forcedOut, [id]);
    // 다시 로그인하면 '정지된 계정'
    const again = await login(h, 'kim01');
    assert.equal(again.status, 403);
    assert.equal(again.body.error.code, 'ACCOUNT_SUSPENDED');

    const { rows } = await h.pool.query(
      "SELECT target_type, target_id::text AS target_id, detail FROM admin_audit_log WHERE action = 'suspend_paramedic'",
    );
    assert.deepEqual(rows, [
      {
        target_type: 'paramedic',
        target_id: id,
        detail: { targetName: '김도윤', reason: '폰 분실' },
      },
    ]);

    // 이미 정지된 계정을 또 정지해도 이력·강제 로그아웃은 한 번만
    assert.equal(
      (await h.admin('post', `/admin/paramedics/${id}/suspend`).send({ reason: 'phone_lost' }))
        .status,
      204,
    );
    assert.equal(h.forcedOut.length, 1);
    const { rows: count } = await h.pool.query(
      "SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'suspend_paramedic'",
    );
    assert.equal(count[0].n, 1);
  });
});

test("이동 중인 대원을 정지하면 '진행 중 이송 1건이 있어요' 경고가 먼저 나오고, 확인하면 마지막 대원이라 이송이 취소된다 (SFR-151 인수 기준)", async () => {
  await withAdminParamedics(async (h) => {
    const id = await addParamedic(h.pool, { loginId: 'kim01' });
    const { transportId } = await movingTeam(h.pool, [id]);

    // 검색 결과에도 진행 중 이송이 보인다
    const list = await h.admin('get', '/admin/paramedics?q=김도');
    assert.equal(list.body.items[0].hasActiveTransport, true);

    const warn = await h
      .admin('post', `/admin/paramedics/${id}/suspend`)
      .send({ reason: 'misuse' });
    assert.equal(warn.status, 409);
    assert.equal(warn.body.error.code, 'ACTIVE_TRANSPORT_CONFIRM_REQUIRED');
    assert.equal(warn.body.error.message, '진행 중 이송 1건이 있어요');
    // 경고만 하고 아무것도 바꾸지 않았다
    const { rows: before } = await h.pool.query('SELECT status FROM paramedic WHERE id = $1', [id]);
    assert.equal(before[0].status, 'approved');
    assert.equal((await transportStatus(h.pool, transportId)).status, 'moving');

    const res = await h
      .admin('post', `/admin/paramedics/${id}/suspend`)
      .send({ reason: 'misuse', confirmCancelActive: true });
    assert.equal(res.status, 204);
    assert.deepEqual(await transportStatus(h.pool, transportId), {
      status: 'cancelled',
      cancel_reason: 'suspended',
    });
    const { rows: member } = await h.pool.query(
      'SELECT left_reason FROM team_member WHERE paramedic_id = $1',
      [id],
    );
    assert.equal(member[0].left_reason, 'suspended');
    assert.ok(h.published.length > 0, '취소 이벤트를 커밋 뒤에 보낸다');
  });
});

test('팀원이 남아 있으면 정지된 대원만 빠지고 이송은 남은 팀원이 이어 간다', async () => {
  await withAdminParamedics(async (h) => {
    const a = await addParamedic(h.pool, { loginId: 'kim01' });
    const b = await addParamedic(h.pool, { loginId: 'lee02' });
    const { transportId } = await movingTeam(h.pool, [a, b]);

    const res = await h
      .admin('post', `/admin/paramedics/${a}/suspend`)
      .send({ reason: 'etc', etcText: '장기 휴직', confirmCancelActive: true });
    assert.equal(res.status, 204);
    assert.equal((await transportStatus(h.pool, transportId)).status, 'moving');
    const { rows } = await h.pool.query(
      "SELECT detail->>'reason' AS reason FROM admin_audit_log WHERE action = 'suspend_paramedic'",
    );
    assert.equal(rows[0].reason, '장기 휴직', '기타는 쓴 내용을 이력에 남긴다');
  });
});

test('정지를 해제하면 다시 로그인할 수 있고, 작업 이력에 남는다 (SFR-151 인수 기준)', async () => {
  await withAdminParamedics(async (h) => {
    const id = await addParamedic(h.pool, { loginId: 'kim01' });
    await h.admin('post', `/admin/paramedics/${id}/suspend`).send({ reason: 'retired' });
    assert.equal((await login(h, 'kim01')).status, 403);

    assert.equal((await h.admin('post', `/admin/paramedics/${id}/unsuspend`)).status, 204);
    assert.equal((await login(h, 'kim01')).status, 200);

    const log = await h.admin('get', '/admin/audit-logs');
    assert.deepEqual(
      log.body.items.map((i: { action: string; target: string }) => [i.action, i.target]),
      [
        ['대원 계정 정지 해제', '김도윤'],
        ['대원 계정 정지', '김도윤'],
      ],
    );
    // 정지되지 않은 계정을 해제해도 아무것도 바뀌지 않는다
    assert.equal((await h.admin('post', `/admin/paramedics/${id}/unsuspend`)).status, 204);
    assert.equal((await h.admin('get', '/admin/audit-logs')).body.items.length, 2);
  });
});

test('대원 검색: 이름·사번 일부로 찾고, 탈퇴한 계정은 빼고, 나눠 받는다', async () => {
  await withAdminParamedics(async (h) => {
    const a = await addParamedic(h.pool, { loginId: 'kim01' });
    await addParamedic(h.pool, { loginId: 'kim02', status: 'pending' });
    await addParamedic(h.pool, { loginId: 'kim03', status: 'withdrawn' });

    const page1 = await h.admin('get', '/admin/paramedics?limit=1');
    assert.equal(page1.status, 200);
    assert.deepEqual(page1.body.items[0], {
      id: Number(a),
      name: '김도윤',
      agencyName: '테스트소방서',
      safetyCenter: '테스트안전센터',
      employeeNo: 'kim01',
      status: 'approved',
      hasActiveTransport: false,
    });
    const page2 = await h.admin('get', `/admin/paramedics?limit=1&cursor=${page1.body.nextCursor}`);
    assert.deepEqual(
      page2.body.items.map((i: { employeeNo: string }) => i.employeeNo),
      ['kim02'],
    );
    assert.equal(page2.body.nextCursor, null);

    // 사번으로도 찾는다 (동명이인 구분)
    const byNo = await h.admin('get', '/admin/paramedics?q=kim02');
    assert.equal(byNo.body.items.length, 1);
  });
});

test('정지: 없는·탈퇴한 계정은 404, 승인 전 계정은 409, 사유가 틀리면 400, 관리자가 아니면 401', async () => {
  await withAdminParamedics(async (h) => {
    const pending = await addParamedic(h.pool, { loginId: 'kim02', status: 'pending' });
    const gone = await addParamedic(h.pool, { loginId: 'kim03', status: 'withdrawn' });
    const ok1 = await addParamedic(h.pool, { loginId: 'kim01' });

    assert.equal(
      (await h.admin('post', '/admin/paramedics/99999/suspend').send({ reason: 'retired' })).status,
      404,
    );
    assert.equal(
      (await h.admin('post', `/admin/paramedics/${gone}/suspend`).send({ reason: 'retired' }))
        .status,
      404,
    );
    const p = await h
      .admin('post', `/admin/paramedics/${pending}/suspend`)
      .send({ reason: 'retired' });
    assert.equal(p.status, 409);
    assert.equal(p.body.error.code, 'INVALID_TRANSITION');
    assert.equal(
      (await h.admin('post', `/admin/paramedics/${ok1}/suspend`).send({ reason: 'bored' })).status,
      400,
    );
    assert.equal((await h.admin('post', '/admin/paramedics/99999/unsuspend')).status, 404);

    for (const [method, path] of [
      ['get', '/admin/paramedics'],
      ['post', `/admin/paramedics/${ok1}/suspend`],
      ['post', `/admin/paramedics/${ok1}/unsuspend`],
    ] as const) {
      const res = await h.app()[method](`/api/v1${path}`).set('Origin', WEB_ORIGIN);
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    const { rows } = await h.pool.query('SELECT status FROM paramedic WHERE id = $1', [ok1]);
    assert.equal(rows[0].status, 'approved');
  });
});

const loginWith = (h: Harness, loginId: string, password: string) =>
  h
    .app()
    .post('/api/v1/auth/login')
    .send({ loginId, password, deviceId: `device-${loginId}` });

test('비밀번호 초기화: 임시 비밀번호가 한 번 표시되고 작업 이력에 1건, 다른 기기 로그인도 끝난다 (SFR-021 인수 기준)', async () => {
  await withAdminParamedics(async (h) => {
    const id = await addParamedic(h.pool, { loginId: 'kim01' });
    const before = (await login(h, 'kim01')).body.tokens.accessToken;

    const res = await h.admin('post', `/admin/paramedics/${id}/reset-password`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const temp: string = res.body.tempPassword;
    assert.match(temp, /^[a-hj-km-np-z2-9]{10}$/, '헷갈리는 글자 없이 10자');

    // 작업 이력 1건, 임시 비밀번호는 어디에도 남기지 않는다
    const { rows } = await h.pool.query(
      "SELECT target_type, detail FROM admin_audit_log WHERE action = 'reset_password'",
    );
    assert.deepEqual(rows, [
      { target_type: 'paramedic', detail: { targetName: '김도윤', reason: null } },
    ]);
    const log = await h.admin('get', '/admin/audit-logs');
    assert.equal(log.body.items[0].action, '대원 비밀번호 초기화');
    assert.doesNotMatch(JSON.stringify(log.body), new RegExp(temp));

    // 옛 비밀번호·옛 토큰은 더 못 쓴다
    const old = await h.app().get('/api/v1/me').set('Authorization', `Bearer ${before}`);
    assert.equal(old.status, 401);
    assert.equal((await login(h, 'kim01')).status, 401);
  });
});

test('임시 비밀번호로 로그인하면 비밀번호 변경만 되고, 바꾼 뒤에는 이전 비밀번호로 들어올 수 없다 (SFR-021 인수 기준)', async () => {
  await withAdminParamedics(async (h) => {
    const id = await addParamedic(h.pool, { loginId: 'kim01' });
    const temp = (await h.admin('post', `/admin/paramedics/${id}/reset-password`)).body
      .tempPassword as string;

    const first = await loginWith(h, 'kim01', temp);
    assert.equal(first.status, 200);
    assert.equal(first.body.me.mustChangePassword, true, '앱은 이걸 보고 변경 화면만 띄운다');
    const token = first.body.tokens.accessToken;
    const bearer = { Authorization: `Bearer ${token}` };

    // 근무 기능은 막히고, 내 정보·비밀번호 변경은 된다
    const team = await h.app().post('/api/v1/teams').set(bearer);
    assert.equal(team.status, 403);
    assert.equal(team.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await h.app().get('/api/v1/me').set(bearer)).status, 200);

    const change = (body: object) => h.app().put('/api/v1/me/password').set(bearer).send(body);
    const wrong = await change({ currentPassword: 'nope', newPassword: 'brand-new-1234' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal((await change({ currentPassword: temp, newPassword: 'short' })).status, 400);
    assert.equal((await change({ currentPassword: temp, newPassword: temp })).status, 400);

    assert.equal(
      (await change({ currentPassword: temp, newPassword: 'brand-new-1234' })).status,
      204,
    );
    // 같은 토큰으로 바로 근무 기능이 열린다
    const after = await h.app().post('/api/v1/teams').set(bearer);
    assert.notEqual(after.body?.error?.code, 'PASSWORD_CHANGE_REQUIRED');
    // 임시 비밀번호(이전 비밀번호)로는 더 못 들어오고, 새 비밀번호로는 바로 쓴다
    assert.equal((await loginWith(h, 'kim01', temp)).status, 401);
    const fresh = await loginWith(h, 'kim01', 'brand-new-1234');
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.me.mustChangePassword, false);
  });
});

test('비밀번호 초기화는 5번 틀려 잠긴 계정도 풀어 준다. 없는·탈퇴한 계정은 404, 관리자가 아니면 401', async () => {
  await withAdminParamedics(async (h) => {
    const id = await addParamedic(h.pool, { loginId: 'kim01' });
    await h.pool.query(
      "UPDATE paramedic SET failed_count = 0, locked_until = now() + interval '10 minutes' WHERE id = $1",
      [id],
    );
    const temp = (await h.admin('post', `/admin/paramedics/${id}/reset-password`)).body
      .tempPassword as string;
    assert.equal((await loginWith(h, 'kim01', temp)).status, 200);

    const gone = await addParamedic(h.pool, { loginId: 'kim03', status: 'withdrawn' });
    assert.equal((await h.admin('post', `/admin/paramedics/${gone}/reset-password`)).status, 404);
    assert.equal((await h.admin('post', '/admin/paramedics/99999/reset-password')).status, 404);
    const noAdmin = await h
      .app()
      .post(`/api/v1/admin/paramedics/${id}/reset-password`)
      .set('Origin', WEB_ORIGIN);
    assert.equal(noAdmin.status, 401);
  });
});
