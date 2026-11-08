// SFR-114 팀원 공동 입력 · SFR-115 주행 중 운전자 입력 잠금을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, login, scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';

const as = (ctx: AuthContext, token: string) => {
  const auth = { Authorization: `Bearer ${token}` };
  return {
    get: () => request(appFor(ctx)).get('/api/v1/teams/current/draft').set(auth),
    patch: (body: object) =>
      request(appFor(ctx)).patch('/api/v1/teams/current/draft').set(auth).send(body),
    clear: () => request(appFor(ctx)).delete('/api/v1/teams/current/draft').set(auth),
  };
};

// 김도윤(운전)·이하준(돌봄) 한 팀
async function team(ctx: AuthContext) {
  const kim = await login(ctx, 'kim01');
  const lee = await login(ctx, 'lee01');
  await ctx.pool.query("UPDATE paramedic SET name = '이하준' WHERE login_id = 'lee01'");
  const created = await request(appFor(ctx))
    .post('/api/v1/teams')
    .set('Authorization', `Bearer ${kim}`)
    .send({ role: 'driver' });
  await request(appFor(ctx))
    .post('/api/v1/teams/join')
    .set('Authorization', `Bearer ${lee}`)
    .send({ code: created.body.code, role: 'care' });
  return { kim, lee, teamId: String(created.body.id) };
}

async function draftEvents(pool: pg.Pool) {
  const { rows } = await pool.query<{ room: string; payload: Record<string, unknown> }>(
    "SELECT room, payload FROM event_log WHERE name = 'draft.updated' ORDER BY seq",
  );
  return rows;
}

test('김도윤이 혈압을 넣으면 이하준도 보고, 이하준이 이어서 맥박을 넣으면 두 칸이 다 남는다', async () => {
  await withAuthContext(async (ctx) => {
    const { kim, lee, teamId } = await team(ctx);
    const empty = await as(ctx, lee).get();
    assert.equal(empty.status, 200);
    assert.deepEqual(
      [empty.body.version, empty.body.assessment, empty.body.fieldMeta],
      [0, {}, {}],
    );

    const first = await as(ctx, kim).patch({ baseVersion: 0, changes: { bp: '160/95' } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { version: 1, assessment: { bp: '160/95' }, overwritten: [] });

    const seen = await as(ctx, lee).get();
    assert.equal(seen.body.assessment.bp, '160/95');
    assert.equal(seen.body.fieldMeta.bp.byName, '김도윤');
    assert.ok(seen.body.fieldMeta.bp.at);

    const second = await as(ctx, lee).patch({ baseVersion: 1, changes: { pulse: 92 } });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.assessment, { bp: '160/95', pulse: 92 });
    assert.equal(second.body.version, 2);

    // 팀원에게는 바뀐 칸 이름만 간다. 값(160/95, 92)은 이벤트에 없다 (규칙 5)
    const events = await draftEvents(ctx.pool);
    assert.deepEqual(events, [
      {
        room: `team:${teamId}`,
        payload: { version: 1, fields: ['bp'], byName: '김도윤', overwritten: [] },
      },
      {
        room: `team:${teamId}`,
        payload: { version: 2, fields: ['pulse'], byName: '이하준', overwritten: [] },
      },
    ]);
    assert.ok(!JSON.stringify(events).includes('160/95'));
  });
});

test('같은 칸을 동시에 고치면 나중 값이 남고, 덮어쓴 사람에게 누구 값을 바꿨는지 알린다', async () => {
  await withAuthContext(async (ctx) => {
    const { kim, lee } = await team(ctx);
    // 둘 다 버전 0을 보고 입력을 시작함
    await as(ctx, lee).patch({ baseVersion: 0, changes: { bp: '150/90' } });
    const late = await as(ctx, kim).patch({ baseVersion: 0, changes: { bp: '160/95' } });
    assert.equal(late.status, 200);
    assert.equal(late.body.assessment.bp, '160/95');
    assert.deepEqual(late.body.overwritten, [{ field: 'bp', prevByName: '이하준' }]);

    // 내가 고친 칸을 내가 다시 고치는 건 알림 없음, 최신 버전을 보고 고쳐도 알림 없음
    const mine = await as(ctx, kim).patch({ baseVersion: 0, changes: { bp: '170/100' } });
    assert.deepEqual(mine.body.overwritten, []);
    const fresh = await as(ctx, lee).patch({ baseVersion: 3, changes: { bp: '140/80' } });
    assert.deepEqual(fresh.body.overwritten, []);

    // null 은 그 칸을 지운다
    const cleared = await as(ctx, lee).patch({ baseVersion: 4, changes: { bp: null } });
    assert.deepEqual(cleared.body.assessment, {});
  });
});

test('동시에 여러 칸을 보내도 한 명씩 합쳐 칸이 사라지지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const { kim, lee } = await team(ctx);
    const results = await Promise.all([
      as(ctx, kim).patch({ baseVersion: 0, changes: { bp: '160/95' } }),
      as(ctx, lee).patch({ baseVersion: 0, changes: { pulse: 92 } }),
      as(ctx, lee).patch({ baseVersion: 0, changes: { spo2: 95 } }),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200, 200],
    );
    const after = await as(ctx, kim).get();
    assert.equal(after.body.version, 3);
    assert.deepEqual(after.body.assessment, { bp: '160/95', pulse: 92, spo2: 95 });
  });
});

test('정해지지 않은 칸(환자 이름 등)·틀린 값·빈 변경은 400, 팀이 없으면 404', async () => {
  await withAuthContext(async (ctx) => {
    const { kim } = await team(ctx);
    for (const changes of [{ patientName: '홍길동' }, { pulse: 'fast' }, {}]) {
      const res = await as(ctx, kim).patch({ baseVersion: 0, changes });
      assert.equal(res.status, 400, JSON.stringify(changes));
      assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    }
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM team_draft');
    assert.equal(rows[0].n, 0);

    const alone = await login(ctx, 'solo01');
    const res = await as(ctx, alone).get();
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_IN_TEAM');
    assert.equal(
      (await as(ctx, alone).patch({ baseVersion: 0, changes: { pulse: 1 } })).status,
      404,
    );
  });
});

test('운전 역할은 시속 10km 이상 달리는 중이면 입력이 잠기고, 정차하면 다시 입력한다', async () => {
  await withAuthContext(async (ctx) => {
    const { kim, lee } = await team(ctx);
    // 단말이 잰 속도 40km (현장에서 출발 전)
    const locked = await as(ctx, kim).patch({
      baseVersion: 0,
      changes: { pulse: 90 },
      speedKmh: 40,
    });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error.code, 'DRIVER_INPUT_LOCKED');
    // 돌봄 역할은 같은 속도여도 입력한다
    assert.equal(
      (await as(ctx, lee).patch({ baseVersion: 0, changes: { pulse: 90 }, speedKmh: 40 })).status,
      200,
    );
    // 정차
    assert.equal(
      (await as(ctx, kim).patch({ baseVersion: 1, changes: { resp: 18 }, speedKmh: 0 })).status,
      200,
    );
    assert.equal(
      (await as(ctx, kim).patch({ baseVersion: 2, changes: { resp: 18 }, speedKmh: 9.9 })).status,
      200,
    );
  });
});

test('단말이 속도를 안 보내도 이송 중 최근 위치 기록이 10km 이상이면 운전 역할을 막는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx); // 김도윤(운전)·이하준(돌봄), 요청 중 이송 건
    const point = (secondsAgo: number, speed: number) =>
      ctx.pool.query(
        `INSERT INTO location_point (transport_id, device_id, lat, lng, speed_kmh, recorded_at)
         VALUES ($1, 'device-kim01', 36.8, 127.1, $2, now() - make_interval(secs => $3))`,
        [s.transportId, speed, secondsAgo],
      );
    await point(3, 40);
    const locked = await as(ctx, s.kim).patch({ baseVersion: 0, changes: { pulse: 90 } });
    assert.equal(locked.status, 403);
    assert.equal(
      (await as(ctx, s.lee).patch({ baseVersion: 0, changes: { pulse: 90 } })).status,
      200,
    );

    // 30초 넘게 기록이 없으면 지금 속도로 보지 않는다 / 가장 최근 기록이 정차면 풀린다
    await ctx.pool.query('DELETE FROM location_point');
    await point(30, 40);
    assert.equal(
      (await as(ctx, s.kim).patch({ baseVersion: 1, changes: { resp: 18 } })).status,
      200,
    );
    await point(5, 40);
    await point(1, 0);
    assert.equal(
      (await as(ctx, s.kim).patch({ baseVersion: 2, changes: { resp: 18 } })).status,
      200,
    );
  });
});

test('작성 중 정보를 비우면 팀원에게 알리고 빈 값이 된다', async () => {
  await withAuthContext(async (ctx) => {
    const { kim, lee } = await team(ctx);
    await as(ctx, kim).patch({ baseVersion: 0, changes: { bp: '160/95' } });
    assert.equal((await as(ctx, lee).clear()).status, 204);
    const after = await as(ctx, kim).get();
    assert.deepEqual([after.body.version, after.body.assessment], [0, {}]);
    const events = await draftEvents(ctx.pool);
    assert.deepEqual(events.at(-1)?.payload, {
      version: 0,
      fields: [],
      byName: '이하준',
      overwritten: [],
    });
    // 비어 있을 때 또 비워도 204, 이벤트는 더 없다
    assert.equal((await as(ctx, lee).clear()).status, 204);
    assert.equal((await draftEvents(ctx.pool)).length, 2);
  });
});
