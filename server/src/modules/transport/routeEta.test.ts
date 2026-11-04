// SFR-129 반경 10km 안 병원은 길찾기 결과로 도착 예상 시간을 바꾸는지 임시 DB로 확인한다 (길찾기는 가짜 함수).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import { ORIGIN, scene } from '../../testing/transportScene.js';
import type { EtaLookup } from './eta.js';
import { refineRoundEtas } from './routeEta.js';

async function etas(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT h.name, hr.eta_min, hr.eta_source FROM hospital_request hr
       JOIN hospital h ON h.id = hr.hospital_id ORDER BY h.name`,
  );
  return rows.map((r) => [r.name, r.eta_min, r.eta_source]);
}

// 가짜 길찾기: 이름표에 있는 병원만 답하고, 물어본 병원 id를 모은다
function fakeEta(pool: pg.Pool, answers: Record<string, number>) {
  const asked: string[] = [];
  const lookup: EtaLookup = async (_origin, destinations) => {
    const { rows } = await pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM hospital WHERE id = ANY($1::bigint[])',
      [destinations.map((d) => d.id)],
    );
    asked.push(...rows.map((r) => r.name));
    return new Map(rows.filter((r) => r.name in answers).map((r) => [r.id, answers[r.name]]));
  };
  return { lookup, asked };
}

async function roundId(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM request_round');
  return rows[0].id;
}

test('10km 안 병원만 길찾기를 부르고, 결과가 온 병원만 바꾼다. 실패·10km 밖은 추정값 그대로', async () => {
  await withAuthContext(async (ctx) => {
    await scene(ctx); // B 2.2km · C 4.4km · D 6.7km
    const round = await roundId(ctx.pool);
    // 13km 떨어진 E병원에도 요청이 갔다고 친다
    const { rows: e } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO hospital (public_id, name, lat, lng) VALUES ('E병원', 'E병원', $1, $2) RETURNING id`,
      [ORIGIN.lat + 0.12, ORIGIN.lng],
    );
    await ctx.pool.query(
      `INSERT INTO hospital_request (round_id, hospital_id, eta_min, eta_source) VALUES ($1, $2, 20, 'straight')`,
      [round, e[0].id],
    );
    const before = await etas(ctx.pool);

    const { lookup, asked } = fakeEta(ctx.pool, { B병원: 7, D병원: 15, E병원: 30 });
    const events = await refineRoundEtas(ctx.pool, lookup, round);

    assert.deepEqual(asked.sort(), ['B병원', 'C병원', 'D병원']);
    const after = await etas(ctx.pool);
    assert.deepEqual(after[0], ['B병원', 7, 'route']);
    assert.deepEqual(after[1], before[1]); // C: 길찾기 실패 → 추정 그대로
    assert.deepEqual(after[2], ['D병원', 15, 'route']);
    assert.deepEqual(after[3], ['E병원', 20, 'straight']);

    // 팀과 그 병원에 request.eta (병원별 2개씩)
    assert.equal(events.filter((x) => x.name === 'request.eta').length, 4);
    assert.ok(events.some((x) => x.room.startsWith('team:') && x.payload.etaMin === 7));
  });
});

test('길찾기를 기다리는 사이 닫힌 요청은 바꾸지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    await scene(ctx);
    const round = await roundId(ctx.pool);
    const { lookup } = fakeEta(ctx.pool, { B병원: 7 });
    const slow: EtaLookup = async (origin, dests) => {
      await ctx.pool.query(
        `UPDATE hospital_request SET status = 'closed', closed_reason = 'cancelled'`,
      );
      return lookup(origin, dests);
    };
    assert.deepEqual(await refineRoundEtas(ctx.pool, slow, round), []);
    assert.equal((await etas(ctx.pool))[0][2], 'straight');
  });
});

test('이송 요청 API가 커밋 뒤 길찾기로 도착 예상을 갱신한다 (카카오 키가 있을 때)', async () => {
  await withAuthContext(async (ctx) => {
    const fake = fakeEta(ctx.pool, { B병원: 7, C병원: 9, D병원: 12 });
    const app = createApp({
      logger: pino({ level: 'silent' }),
      healthChecks: { db: async () => 'ok', redis: async () => 'ok' },
      auth: ctx,
      eta: fake.lookup,
    });
    await scene(ctx);
    // scene은 길찾기 없는 앱으로 만들었으니 같은 팀으로 새 이송 건을 하나 더 보낸다
    await ctx.pool.query(`UPDATE transport SET status = 'cancelled'`);
    const { rows } = await ctx.pool.query<{ login_id: string }>(
      "SELECT login_id FROM paramedic WHERE login_id = 'kim01'",
    );
    assert.equal(rows.length, 1);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ loginId: 'kim01', password: TEST_PASSWORD, deviceId: 'd2' });
    const res = await request(app)
      .post('/api/v1/transports')
      .set('Authorization', `Bearer ${login.body.tokens.accessToken}`)
      .send({
        id: randomUUID(),
        radiusKm: 20,
        location: ORIGIN,
        locationConsent: true,
        assessment: { chiefComplaint: '두통' },
      });
    assert.equal(res.status, 201);
    for (let i = 0; i < 30; i += 1) {
      const { rows: done } = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
          WHERE r.transport_id = $1 AND hr.eta_source = 'route'`,
        [res.body.id],
      );
      if (done[0].n === 3) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail('길찾기 결과가 반영되지 않았어요');
  });
});
