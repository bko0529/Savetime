// SFR-113 팀 맺기 인수 기준을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import type { AuthContext } from '../auth/session.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

function appFor(ctx: AuthContext) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
}

async function login(ctx: AuthContext, loginId: string): Promise<string> {
  const res = await request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  assert.equal(res.status, 200);
  return res.body.tokens.accessToken;
}

// 대원을 만들고 로그인까지 해서 접근 토큰을 돌려준다
async function paramedics(ctx: AuthContext, count: number): Promise<string[]> {
  const tokens: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    await addParamedic(ctx.pool, { loginId: `p${i}` });
    tokens.push(await login(ctx, `p${i}`));
  }
  return tokens;
}

const api = (ctx: AuthContext, token: string) => ({
  create: (role: string) =>
    request(appFor(ctx))
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ role }),
  join: (body: object) =>
    request(appFor(ctx))
      .post('/api/v1/teams/join')
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  current: () =>
    request(appFor(ctx)).get('/api/v1/teams/current').set('Authorization', `Bearer ${token}`),
  setRole: (role: string) =>
    request(appFor(ctx))
      .patch('/api/v1/teams/current/members/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ role }),
  leave: (confirm = false) =>
    request(appFor(ctx))
      .post(`/api/v1/teams/current/leave${confirm ? '?confirmCancelActive=true' : ''}`)
      .set('Authorization', `Bearer ${token}`),
});

test('팀을 만들면 4자리 코드와 QR이 나오고, 다른 대원이 코드로 참여하면 한 팀이 된다', async () => {
  await withAuthContext(async (ctx) => {
    const [a, b] = await paramedics(ctx, 2);
    const created = await api(ctx, a).create('driver');
    assert.equal(created.status, 201);
    assert.match(created.body.code, /^\d{4}$/);
    assert.ok(created.body.qrToken.length >= 20);
    assert.equal(created.body.maxMembers, 4);
    assert.deepEqual(
      created.body.members.map((m: { role: string; isMe: boolean }) => [m.role, m.isMe]),
      [['driver', true]],
    );

    const joined = await api(ctx, b).join({ code: created.body.code, role: 'care' });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.id, created.body.id);
    assert.deepEqual(
      joined.body.members.map((m: { role: string; isMe: boolean }) => [m.role, m.isMe]),
      [
        ['driver', false],
        ['care', true],
      ],
    );

    // 만든 사람 화면에도 두 명이 보인다
    const seen = await api(ctx, a).current();
    assert.equal(seen.body.members.length, 2);
  });
});

test('QR 토큰으로도 참여할 수 있고, 코드와 QR을 둘 다 보내면 거절한다', async () => {
  await withAuthContext(async (ctx) => {
    const [a, b] = await paramedics(ctx, 2);
    const { body: team } = await api(ctx, a).create('care');

    const both = await api(ctx, b).join({ code: team.code, qrToken: team.qrToken, role: 'care' });
    assert.equal(both.status, 400);

    const joined = await api(ctx, b).join({ qrToken: team.qrToken, role: 'driver' });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.id, team.id);
  });
});

test('없는 코드는 TEAM_NOT_FOUND, 해제된 팀의 코드도 찾지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const [a, b] = await paramedics(ctx, 2);
    const { body: team } = await api(ctx, a).create('care');
    const wrong = team.code === '0000' ? '0001' : '0000';
    assert.equal(
      (await api(ctx, b).join({ code: wrong, role: 'care' })).body.error.code,
      'TEAM_NOT_FOUND',
    );

    // 만든 사람이 근무를 끝내면 팀이 해제된다
    assert.equal((await api(ctx, a).leave()).status, 204);
    const res = await api(ctx, b).join({ code: team.code, role: 'care' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TEAM_NOT_FOUND');
  });
});

test('팀원이 4명이면 5번째 대원은 참여하지 못한다', async () => {
  await withAuthContext(async (ctx) => {
    const tokens = await paramedics(ctx, 5);
    const { body: team } = await api(ctx, tokens[0]).create('driver');
    for (const t of tokens.slice(1, 4)) {
      assert.equal((await api(ctx, t).join({ code: team.code, role: 'care' })).status, 200);
    }
    const res = await api(ctx, tokens[4]).join({ code: team.code, role: 'care' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TEAM_FULL');
    assert.equal(res.body.error.message, '팀 인원이 가득 찼어요(최대 4명)');
  });
});

test('동시에 여러 명이 참여해도 4명을 넘지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const tokens = await paramedics(ctx, 6);
    const { body: team } = await api(ctx, tokens[0]).create('driver');
    const results = await Promise.all(
      tokens.slice(1).map((t) => api(ctx, t).join({ code: team.code, role: 'care' })),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    assert.equal(results.filter((r) => r.body.error?.code === 'TEAM_FULL').length, 2);
  });
});

test("'운전'은 팀에 1명만: 참여·역할 바꾸기 모두 막고, 동시에 골라도 1명만 된다", async () => {
  await withAuthContext(async (ctx) => {
    const [a, b, c] = await paramedics(ctx, 3);
    const { body: team } = await api(ctx, a).create('driver');

    const taken = await api(ctx, b).join({ code: team.code, role: 'driver' });
    assert.equal(taken.body.error.code, 'DRIVER_TAKEN');

    await api(ctx, b).join({ code: team.code, role: 'care' });
    await api(ctx, c).join({ code: team.code, role: 'care' });
    assert.equal((await api(ctx, b).setRole('driver')).body.error.code, 'DRIVER_TAKEN');

    // 운전이 처치로 바꾸면 그 자리가 빈다. 두 명이 동시에 운전을 골라도 1명만 된다
    assert.equal((await api(ctx, a).setRole('care')).status, 200);
    const results = await Promise.all([
      api(ctx, b).setRole('driver'),
      api(ctx, c).setRole('driver'),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);

    // 자기 자신이 이미 운전이면 다시 골라도 된다
    const driver = results.find((r) => r.status === 200)!;
    const driverToken = driver === results[0] ? b : c;
    assert.equal((await api(ctx, driverToken).setRole('driver')).status, 200);
  });
});

test('이미 팀에 있으면 새로 만들거나 다른 팀에 참여할 수 없고, 동시에 두 번 만들어도 팀은 1개다', async () => {
  await withAuthContext(async (ctx) => {
    const [a, b] = await paramedics(ctx, 2);
    const results = await Promise.all([api(ctx, a).create('care'), api(ctx, a).create('care')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409)!.body.error.code, 'ALREADY_IN_TEAM');

    const { body: other } = await api(ctx, b).create('care');
    assert.equal(
      (await api(ctx, a).join({ code: other.code, role: 'care' })).body.error.code,
      'ALREADY_IN_TEAM',
    );
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM team');
    assert.equal(rows[0].n, 2);
  });
});

test('팀이 없으면 내 팀 보기·역할 바꾸기·근무 종료는 NOT_IN_TEAM이고, 근무 종료는 로그인을 끊지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const [a] = await paramedics(ctx, 1);
    for (const res of [
      await api(ctx, a).current(),
      await api(ctx, a).setRole('care'),
      await api(ctx, a).leave(),
    ]) {
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_IN_TEAM');
    }
    // 실패한 근무 종료는 롤백되어 토큰이 그대로 쓰인다
    assert.equal((await api(ctx, a).create('care')).status, 201);
  });
});

test('승인 전 계정은 팀에 참여할 수 없다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool, { loginId: 'wait', status: 'pending' });
    const token = await login(ctx, 'wait');
    const res = await api(ctx, token).create('care');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'NOT_APPROVED');
  });
});

test('이송 중에는 역할을 바꿀 수 없다', async () => {
  await withAuthContext(async (ctx) => {
    const [a] = await paramedics(ctx, 1);
    const { body: team } = await api(ctx, a).create('care');
    await ctx.pool.query(
      `INSERT INTO transport (id, team_id, status, location_consent) VALUES ($1, $2, 'requesting', true)`,
      [randomUUID(), team.id],
    );
    const res = await api(ctx, a).setRole('driver');
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ACTIVE_TRANSPORT_EXISTS');
  });
});

test('근무 종료하면 나만 빠지고 로그인도 끝난다. 남은 팀원은 팀을 그대로 쓴다', async () => {
  await withAuthContext(async (ctx) => {
    const [a, b] = await paramedics(ctx, 2);
    const { body: team } = await api(ctx, a).create('driver');
    await api(ctx, b).join({ code: team.code, role: 'care' });

    assert.equal((await api(ctx, a).leave()).status, 204);
    assert.equal((await api(ctx, a).current()).body.error.code, 'TOKEN_REVOKED');

    const rest = await api(ctx, b).current();
    assert.equal(rest.status, 200);
    assert.equal(rest.body.members.length, 1);
    // 운전이 빠졌으니 남은 팀원이 운전을 고를 수 있다
    assert.equal((await api(ctx, b).setRole('driver')).status, 200);
  });
});

test('진행 중 이송이 있으면 근무 종료 전에 확인을 받는다', async () => {
  await withAuthContext(async (ctx) => {
    const [a] = await paramedics(ctx, 1);
    const { body: team } = await api(ctx, a).create('care');
    const transportId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO transport (id, team_id, status, location_consent) VALUES ($1, $2, 'fallback', true)`,
      [transportId, team.id],
    );
    const ask = await api(ctx, a).leave();
    assert.equal(ask.status, 409);
    assert.equal(ask.body.error.code, 'ACTIVE_TRANSPORT_CONFIRM_REQUIRED');

    assert.equal((await api(ctx, a).leave(true)).status, 204);
    const { rows } = await ctx.pool.query(
      `SELECT t.status, t.cancel_reason, tm.ended_at IS NOT NULL AS ended
         FROM transport t JOIN team tm ON tm.id = t.team_id WHERE t.id = $1`,
      [transportId],
    );
    assert.deepEqual(rows[0], { status: 'cancelled', cancel_reason: 'duty_end', ended: true });
  });
});
