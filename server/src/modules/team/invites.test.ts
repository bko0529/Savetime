// SFR-159 팀원 목록 초대 인수 기준을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import type { AuthContext } from '../auth/session.js';
import { expireInvite } from './invites.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

function appFor(ctx: AuthContext) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
}

interface Person {
  id: string;
  token?: string; // 로그인했으면(= 근무 중) 접근 토큰
}

// 대원 1명. login=true 면 로그인까지 해서 '근무 중'이 된다
async function person(
  ctx: AuthContext,
  loginId: string,
  opts: {
    name?: string;
    employeeNo?: string;
    agency?: string;
    status?: 'approved' | 'pending';
    login?: boolean;
  } = {},
): Promise<Person> {
  const id = await addParamedic(ctx.pool, { loginId, status: opts.status ?? 'approved' });
  if (opts.agency) {
    await ctx.pool.query(
      `INSERT INTO agency (code, name, region) VALUES ($1, '다른소방서', '충청남도') ON CONFLICT (code) DO NOTHING`,
      [opts.agency],
    );
  }
  await ctx.pool.query(
    `UPDATE paramedic SET name = coalesce($2, name), employee_no = coalesce($3, employee_no),
            agency_id = coalesce((SELECT id FROM agency WHERE code = $4), agency_id)
      WHERE id = $1`,
    [id, opts.name ?? null, opts.employeeNo ?? null, opts.agency ?? null],
  );
  if (opts.login === false || opts.status === 'pending') return { id };
  const res = await request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  assert.equal(res.status, 200);
  return { id, token: res.body.tokens.accessToken };
}

const as = (ctx: AuthContext, who: Person) => {
  const auth = { Authorization: `Bearer ${who.token}` };
  return {
    createTeam: (role = 'driver') =>
      request(appFor(ctx)).post('/api/v1/teams').set(auth).send({ role }),
    join: (code: string, role = 'care') =>
      request(appFor(ctx)).post('/api/v1/teams/join').set(auth).send({ code, role }),
    list: (query: Record<string, string> = {}) =>
      request(appFor(ctx)).get('/api/v1/paramedics/on-duty').query(query).set(auth),
    invite: (to: Person) =>
      request(appFor(ctx))
        .post('/api/v1/teams/current/invites')
        .set(auth)
        .send({ toParamedicId: Number(to.id) }),
    accept: (inviteId: number, role = 'care') =>
      request(appFor(ctx)).post(`/api/v1/invites/${inviteId}/accept`).set(auth).send({ role }),
    decline: (inviteId: number) =>
      request(appFor(ctx)).post(`/api/v1/invites/${inviteId}/decline`).set(auth),
  };
};

async function lastSeq(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query('SELECT coalesce(max(seq), 0)::int AS n FROM event_log');
  return rows[0].n;
}

async function eventsAfter(pool: pg.Pool, seq: number) {
  const { rows } = await pool.query<{
    room: string;
    name: string;
    payload: Record<string, unknown>;
  }>('SELECT room, name, payload FROM event_log WHERE seq > $1 ORDER BY seq', [seq]);
  return rows;
}

test('근무 중 목록: 같은 소방서의 근무 중·승인된 대원만, 이름·계급·안전센터·사번 뒤 4자리로 보인다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim', { name: '김도윤' });
    const lee = await person(ctx, 'lee', { name: '이하준', employeeNo: '2026001234' });
    await person(ctx, 'other', { name: '박다른', agency: 'OTHER-01' }); // 다른 소방서
    await person(ctx, 'wait', { name: '최대기', status: 'pending' }); // 승인 전
    await person(ctx, 'off', { name: '정쉼', login: false }); // 근무 아님

    const res = await as(ctx, kim).list();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, [
      {
        paramedicId: Number(lee.id),
        name: '이하준',
        rank: '소방교',
        safetyCenter: '테스트안전센터',
        employeeNoTail: '1234',
        myMemo: null,
        onDuty: true,
        inTeam: false,
        inviteStatus: 'none',
      },
    ]);
    assert.equal(res.body.nextCursor, null);

    // 로그아웃(근무 종료)하면 목록에서 빠진다
    await request(appFor(ctx))
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${lee.token}`);
    const after = await as(ctx, kim).list();
    assert.deepEqual(after.body.items, []);
  });
});

test('이름 검색: 근무 중이 아닌 동명이인 2명도 소방서 전체에서 찾아 사번 뒤 4자리로 구분한다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim', { name: '김도윤' });
    await person(ctx, 'm1', { name: '김민수', employeeNo: 'A-1111', login: false });
    await person(ctx, 'm2', { name: '김민수', employeeNo: 'B-2222', login: false });
    await person(ctx, 'x', { name: '%', login: false });

    const res = await as(ctx, kim).list({ q: '김민수' });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((i: { name: string; employeeNoTail: string; onDuty: boolean }) => [
        i.name,
        i.employeeNoTail,
        i.onDuty,
      ]),
      [
        ['김민수', '1111', false],
        ['김민수', '2222', false],
      ],
    );
    // % 는 글자 그대로 찾는다 (전체 목록이 나오지 않음)
    const percent = await as(ctx, kim).list({ q: '%' });
    assert.deepEqual(
      percent.body.items.map((i: { name: string }) => i.name),
      ['%'],
    );
  });
});

test('목록은 커서로 나눠 받고, 근무 중인 사람이 먼저 나온다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim', { name: '김도윤' });
    await person(ctx, 'a', { name: '가나다', login: false });
    await person(ctx, 'b', { name: '하준', login: true });
    await person(ctx, 'c', { name: '나라', login: true });

    const first = await as(ctx, kim).list({ q: '', limit: '2' });
    assert.equal(first.status, 200);
    assert.deepEqual(
      first.body.items.map((i: { name: string }) => i.name),
      ['나라', '하준'],
    );
    // q 가 비면 근무 중만(2명)이라 다음 페이지는 없다
    assert.equal(first.body.nextCursor, null);

    // 검색은 소방서 전체: 근무 중(나라) 다음에 근무 아님(가나다)
    const all1 = await as(ctx, kim).list({ q: '나', limit: '1' });
    assert.deepEqual(
      all1.body.items.map((i: { name: string }) => i.name),
      ['나라'],
    );
    const all2 = await as(ctx, kim).list({ q: '나', limit: '1', cursor: all1.body.nextCursor });
    assert.deepEqual(
      all2.body.items.map((i: { name: string }) => i.name),
      ['가나다'],
    );
    assert.equal(all2.body.nextCursor, null);

    const bad = await as(ctx, kim).list({ cursor: 'not-a-cursor' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
  });
});

test('초대 → 수락: 두 사람이 한 팀이 되고, 보낸 사람·팀원에게 결과가 간다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim', { name: '김도윤' });
    const lee = await person(ctx, 'lee', { name: '이하준' });
    const team = await as(ctx, kim).createTeam('driver');
    assert.equal(team.status, 201);

    const seq = await lastSeq(ctx.pool);
    const sent = await as(ctx, kim).invite(lee);
    assert.equal(sent.status, 201);
    assert.ok(sent.body.inviteId > 0);
    const left = new Date(sent.body.expiresAt).getTime() - Date.now();
    assert.ok(left > 4 * 60_000 && left <= 5 * 60_000 + 5_000, `남은 시간 ${left}ms`);

    const invited = await eventsAfter(ctx.pool, seq);
    assert.deepEqual(invited, [
      {
        room: `paramedic:${lee.id}`,
        name: 'team.invited',
        payload: {
          inviteId: sent.body.inviteId,
          teamCode: team.body.code,
          fromName: '김도윤',
          expiresAt: sent.body.expiresAt,
        },
      },
    ]);

    // 두 번 눌러도 초대는 1건, 알림도 1번
    const again = await as(ctx, kim).invite(lee);
    assert.equal(again.body.inviteId, sent.body.inviteId);
    assert.equal((await eventsAfter(ctx.pool, seq)).length, 1);

    const listed = await as(ctx, kim).list();
    assert.equal(listed.body.items[0].inviteStatus, 'sent');

    const seq2 = await lastSeq(ctx.pool);
    const accepted = await as(ctx, lee).accept(sent.body.inviteId, 'care');
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.id, team.body.id);
    assert.deepEqual(
      accepted.body.members.map((m: { name: string; role: string; isMe: boolean }) => [
        m.name,
        m.role,
        m.isMe,
      ]),
      [
        ['김도윤', 'driver', false],
        ['이하준', 'care', true],
      ],
    );
    assert.deepEqual(await eventsAfter(ctx.pool, seq2), [
      {
        room: `paramedic:${kim.id}`,
        name: 'team.invite_result',
        payload: { inviteId: sent.body.inviteId, toName: '이하준', result: 'accepted' },
      },
      {
        room: `team:${team.body.id}`,
        name: 'team.member_joined',
        payload: { paramedicId: Number(lee.id), name: '이하준', role: 'care' },
      },
    ]);

    const now = await as(ctx, kim).list();
    assert.equal(now.body.items[0].inviteStatus, 'accepted');
    assert.equal(now.body.items[0].inTeam, true);

    // 이미 수락한 초대는 다시 쓸 수 없다
    const twice = await as(ctx, lee).accept(sent.body.inviteId, 'care');
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'INVITE_EXPIRED');
  });
});

test('거절: 팀에 들어가지 않고 보낸 사람에게 거절이 간다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim', { name: '김도윤' });
    const lee = await person(ctx, 'lee', { name: '이하준' });
    await as(ctx, kim).createTeam();
    const sent = await as(ctx, kim).invite(lee);

    const seq = await lastSeq(ctx.pool);
    const declined = await as(ctx, lee).decline(sent.body.inviteId);
    assert.equal(declined.status, 204);
    assert.deepEqual(await eventsAfter(ctx.pool, seq), [
      {
        room: `paramedic:${kim.id}`,
        name: 'team.invite_result',
        payload: { inviteId: sent.body.inviteId, toName: '이하준', result: 'declined' },
      },
    ]);
    const accept = await as(ctx, lee).accept(sent.body.inviteId);
    assert.equal(accept.body.error.code, 'INVITE_EXPIRED');
    const listed = await as(ctx, kim).list();
    assert.equal(listed.body.items[0].inTeam, false);
    // 거절 뒤에는 다시 초대할 수 있다
    const again = await as(ctx, kim).invite(lee);
    assert.notEqual(again.body.inviteId, sent.body.inviteId);
  });
});

test('초대할 수 없는 경우: 팀 없음·다른 팀에 있음·다른 소방서·승인 전·팀이 꽉 참', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim', { name: '김도윤' });
    const seo = await person(ctx, 'seo', { name: '이서준' });
    const other = await person(ctx, 'other', { agency: 'OTHER-01' });
    const wait = await person(ctx, 'wait', { status: 'pending' });

    const noTeam = await as(ctx, kim).invite(seo);
    assert.equal(noTeam.status, 404);
    assert.equal(noTeam.body.error.code, 'NOT_IN_TEAM');

    const theirs = await as(ctx, seo).createTeam(); // 이서준은 이미 다른 팀
    const mine = await as(ctx, kim).createTeam();
    const inTeam = await as(ctx, kim).invite(seo);
    assert.equal(inTeam.status, 409);
    assert.equal(inTeam.body.error.code, 'TARGET_IN_TEAM');

    for (const target of [other, wait, kim]) {
      const res = await as(ctx, kim).invite(target);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }

    const extra: Person[] = [];
    for (const n of [1, 2, 3]) {
      const p = await person(ctx, `m${n}`);
      assert.equal((await as(ctx, p).join(mine.body.code)).status, 200);
      extra.push(p);
    }
    const free = await person(ctx, 'free');
    const full = await as(ctx, kim).invite(free);
    assert.equal(full.status, 409);
    assert.equal(full.body.error.code, 'TEAM_FULL');
    assert.ok(theirs.body.id);
  });
});

test('남의 초대는 수락·거절할 수 없고(404), 이미 팀에 있으면 수락할 수 없다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim');
    const lee = await person(ctx, 'lee');
    const park = await person(ctx, 'park');
    await as(ctx, kim).createTeam();
    const sent = await as(ctx, kim).invite(lee);

    assert.equal((await as(ctx, park).accept(sent.body.inviteId)).status, 404);
    assert.equal((await as(ctx, park).decline(sent.body.inviteId)).status, 404);
    assert.equal((await as(ctx, park).accept(999999)).status, 404);

    await as(ctx, lee).createTeam('care'); // 그 사이 스스로 팀을 만듦
    const res = await as(ctx, lee).accept(sent.body.inviteId);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ALREADY_IN_TEAM');
  });
});

test('5분 만료: 지나면 수락할 수 없고, 만료 작업이 보낸 사람에게 만료를 알린다 (DB 시각 기준)', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim');
    const lee = await person(ctx, 'lee', { name: '이하준' });
    await as(ctx, kim).createTeam();
    const sent = await as(ctx, kim).invite(lee);
    const id = String(sent.body.inviteId);

    // 아직 5분 전이면 만료하지 않는다 (일찍 깨어난 작업)
    assert.equal(await expireInvite(ctx.pool, id), 'not_due');

    await ctx.pool.query(
      "UPDATE team_invite SET expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    const late = await as(ctx, lee).accept(sent.body.inviteId);
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'INVITE_EXPIRED');
    const listed = await as(ctx, kim).list();
    assert.equal(listed.body.items[0].inviteStatus, 'none');

    const events = await expireInvite(ctx.pool, id);
    assert.ok(Array.isArray(events));
    assert.deepEqual(
      events.map((e) => [e.room, e.name, e.payload]),
      [
        [
          `paramedic:${kim.id}`,
          'team.invite_result',
          { inviteId: sent.body.inviteId, toName: '이하준', result: 'expired' },
        ],
      ],
    );
    // 두 번 돌아도 한 번만 (멱등)
    assert.equal(await expireInvite(ctx.pool, id), null);
  });
});

test('자리가 1개 남았을 때 두 사람이 동시에 수락하면 1명만 들어간다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim');
    const team = await as(ctx, kim).createTeam();
    for (const n of [1, 2]) {
      const p = await person(ctx, `m${n}`);
      await as(ctx, p).join(team.body.code);
    }
    const a = await person(ctx, 'a');
    const b = await person(ctx, 'b');
    const ia = await as(ctx, kim).invite(a);
    const ib = await as(ctx, kim).invite(b);

    const results = await Promise.all([
      as(ctx, a).accept(ia.body.inviteId),
      as(ctx, b).accept(ib.body.inviteId),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409)?.body.error.code, 'TEAM_FULL');
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM team_member WHERE team_id = $1 AND left_at IS NULL',
      [team.body.id],
    );
    assert.equal(rows[0].n, 4);
  });
});

test('코드로 참여해도 팀원들에게 team.member_joined 가 간다', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await person(ctx, 'kim');
    const lee = await person(ctx, 'lee', { name: '이하준' });
    const team = await as(ctx, kim).createTeam();
    const seq = await lastSeq(ctx.pool);
    const joined = await as(ctx, lee).join(team.body.code, 'care');
    assert.equal(joined.status, 200);
    assert.equal(joined.body.events, undefined);
    assert.deepEqual(await eventsAfter(ctx.pool, seq), [
      {
        room: `team:${team.body.id}`,
        name: 'team.member_joined',
        payload: { paramedicId: Number(lee.id), name: '이하준', role: 'care' },
      },
    ]);
  });
});
