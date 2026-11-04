// SFR-124 응답 제한 2분 · SFR-112 승인 없으면 예비 추천을 임시 DB로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { addParamedic } from '../../testing/auth.js';
import { withSchemaPool } from '../../testing/services.js';
import { expireRound } from './expire.js';

// 활성 팀끼리 코드가 겹치면 안 돼서 하나씩 늘린다
let teamCount = 0;

interface Setup {
  transportId: string;
  roundId: string;
  teamId: string;
  hospitals: Record<string, string>;
}

// 팀 1개의 요청 중 이송 건과 회차 1. statuses = 병원별 요청 상태, respondIn = 마감까지 남은 시간(음수면 지남)
async function setup(
  pool: pg.Pool,
  statuses: Record<string, string>,
  respondIn = '-1 second',
  transportStatus = 'requesting',
): Promise<Setup> {
  const paramedicId = await addParamedic(pool, { loginId: `p${randomUUID().slice(0, 8)}` });
  const { rows: team } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ($3, $1, $2) RETURNING id`,
    [randomUUID(), paramedicId, String(1000 + (teamCount += 1))],
  );
  const transportId = randomUUID();
  await pool.query(
    `INSERT INTO transport (id, team_id, status, location_consent) VALUES ($1, $2, $3, true)`,
    [transportId, team[0].id, transportStatus],
  );
  const { rows: round } = await pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() - interval '2 minutes', now() + $2::interval, now() + interval '3 minutes')
     RETURNING id`,
    [transportId, respondIn],
  );
  const hospitals: Record<string, string> = {};
  for (const [name, status] of Object.entries(statuses)) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO hospital (public_id, name, lat, lng) VALUES ($1, $1, 36.8, 127.1) RETURNING id`,
      [`${name}-${transportId.slice(0, 6)}`],
    );
    hospitals[name] = rows[0].id;
    await pool.query(
      `INSERT INTO hospital_request (round_id, hospital_id, status, delivered_at) VALUES ($1, $2, $3, now())`,
      [round[0].id, rows[0].id, status],
    );
  }
  return { transportId, roundId: round[0].id, teamId: team[0].id, hospitals };
}

async function state(pool: pg.Pool, transportId: string) {
  const { rows: t } = await pool.query(
    'SELECT status, fallback_reason, version FROM transport WHERE id = $1',
    [transportId],
  );
  const { rows: requests } = await pool.query(
    `SELECT h.name, hr.status, hr.version FROM hospital_request hr
       JOIN hospital h ON h.id = hr.hospital_id JOIN request_round r ON r.id = hr.round_id
      WHERE r.transport_id = $1 ORDER BY h.name`,
    [transportId],
  );
  return { transport: t[0], requests: requests.map((r) => [r.name.split('-')[0], r.status]) };
}

test('2분 전에 깨어나면 아무것도 바꾸지 않고 not_due를 돌려준다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'waiting' }, '30 seconds');
    assert.equal(await expireRound(pool, s.roundId), 'not_due');
    assert.deepEqual((await state(pool, s.transportId)).requests, [['A', 'waiting']]);
  });
});

test('승인 없이 2분이 지나면 대기 요청을 만료로 바꾸고 이송 건을 예비 추천(expired_no_approval)으로 바꾼다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'waiting', B: 'waiting', C: 'rejected' });
    const events = await expireRound(pool, s.roundId);
    assert.ok(Array.isArray(events));

    assert.deepEqual(await state(pool, s.transportId), {
      transport: { status: 'fallback', fallback_reason: 'expired_no_approval', version: 2 },
      requests: [
        ['A', 'expired'],
        ['B', 'expired'],
        ['C', 'rejected'],
      ],
    });
    const { rows: history } = await pool.query(
      'SELECT event, reason FROM transport_status_history WHERE transport_id = $1',
      [s.transportId],
    );
    assert.deepEqual(history, [{ event: 'NO_OPEN_REQUEST', reason: 'expired_no_approval' }]);

    // 병원 웹에는 만료된 요청마다 request.changed, 팀에는 request.expired와 transport.status
    assert.deepEqual(
      events.map((e) => [e.room, e.name]),
      [
        [`hospital:${s.hospitals.A}`, 'request.changed'],
        [`hospital:${s.hospitals.B}`, 'request.changed'],
        [`team:${s.teamId}`, 'request.expired'],
        [`team:${s.teamId}`, 'transport.status'],
      ],
    );
    assert.equal(events[0].payload.status, 'expired');
    assert.equal(events[2].payload.anyApproved, false);
    assert.equal(events[3].payload.reason, 'expired_no_approval');
    // 이벤트에는 ID·개수·시각만 (절대 규칙 5)
    for (const e of events) {
      assert.ok(
        Object.keys(e.payload).every(
          (k) => !/name|complaint|assessment/i.test(k) || k === 'byName' || k === 'pcName',
        ),
      );
    }
  });
});

test('승인한 병원이 있으면 나머지만 만료되고 요청 중을 유지한다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'waiting', B: 'approved' });
    const events = await expireRound(pool, s.roundId);
    assert.ok(Array.isArray(events));
    assert.deepEqual(await state(pool, s.transportId), {
      transport: { status: 'requesting', fallback_reason: null, version: 1 },
      requests: [
        ['A', 'expired'],
        ['B', 'approved'],
      ],
    });
    assert.deepEqual(
      events.map((e) => e.name),
      ['request.changed', 'request.expired'],
    );
    assert.equal(events[1].payload.anyApproved, true);
  });
});

test('두 번 실행되거나 이미 끝난 이송 건이면 아무것도 바꾸지 않는다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'waiting' });
    await expireRound(pool, s.roundId);
    const before = await state(pool, s.transportId);
    assert.deepEqual(await expireRound(pool, s.roundId), []);
    assert.deepEqual(await state(pool, s.transportId), before);

    // 취소된 이송 건: 열린 요청은 이미 닫혀 있다
    const c = await setup(pool, { A: 'closed' }, '-1 second', 'cancelled');
    assert.deepEqual(await expireRound(pool, c.roundId), []);
    assert.equal((await state(pool, c.transportId)).transport.status, 'cancelled');
    assert.equal(await expireRound(pool, '999999'), null);
  });
});

test('지난 회차의 만료는 요청을 만료로만 바꾸고 새 회차가 진행 중인 이송 건은 건드리지 않는다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'waiting' });
    await pool.query(
      `INSERT INTO request_round (transport_id, round_no, kind, radius_km, respond_until, approval_valid_until)
       VALUES ($1, 2, 'expand', 30, now() + interval '2 minutes', now() + interval '5 minutes')`,
      [s.transportId],
    );
    const events = await expireRound(pool, s.roundId);
    assert.ok(Array.isArray(events));
    assert.deepEqual(await state(pool, s.transportId), {
      transport: { status: 'requesting', fallback_reason: null, version: 1 },
      requests: [['A', 'expired']],
    });
    assert.ok(!events.some((e) => e.name === 'transport.status'));
  });
});
