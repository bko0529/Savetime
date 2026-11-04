// SFR-127 승인 유효시간 5분 (4분 해제 경보 · 5분 승인 해제)을 임시 DB로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { addParamedic } from '../../testing/auth.js';
import { withSchemaPool } from '../../testing/services.js';
import { endApprovalWindow, warnApprovalExpiring } from './approvalWindow.js';

let teamCount = 0;

interface Setup {
  transportId: string;
  roundId: string;
  teamId: string;
  hospitals: Record<string, string>;
}

// 요청 2분은 이미 지났고, validIn = 승인 유효시간까지 남은 시간(음수면 지남)
async function setup(
  pool: pg.Pool,
  statuses: Record<string, string>,
  validIn = '-1 second',
  transportStatus = 'requesting',
): Promise<Setup> {
  const paramedicId = await addParamedic(pool, { loginId: `p${randomUUID().slice(0, 8)}` });
  const { rows: team } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ($3, $1, $2) RETURNING id`,
    [randomUUID(), paramedicId, String(3000 + (teamCount += 1))],
  );
  const transportId = randomUUID();
  await pool.query(
    `INSERT INTO transport (id, team_id, status, location_consent) VALUES ($1, $2, $3, true)`,
    [transportId, team[0].id, transportStatus],
  );
  const { rows: round } = await pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() + $2::interval - interval '5 minutes',
             now() + $2::interval - interval '3 minutes', now() + $2::interval)
     RETURNING id`,
    [transportId, validIn],
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
    `SELECT h.name, hr.status, hr.closed_reason FROM hospital_request hr
       JOIN hospital h ON h.id = hr.hospital_id JOIN request_round r ON r.id = hr.round_id
      WHERE r.transport_id = $1 ORDER BY h.name`,
    [transportId],
  );
  return {
    transport: t[0],
    requests: requests.map((r) => [r.name.split('-')[0], r.status, r.closed_reason]),
  };
}

test('5분 전에 깨어나면 아무것도 바꾸지 않고 not_due를 돌려준다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'approved' }, '30 seconds');
    assert.equal(await endApprovalWindow(pool, s.roundId), 'not_due');
    assert.deepEqual((await state(pool, s.transportId)).requests, [['A', 'approved', null]]);
  });
});

test('승인했지만 5분 동안 고르지 않으면 승인을 닫고 예비 추천(approval_window)으로 바꾼다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'approved', B: 'approved', C: 'rejected', D: 'expired' });
    const events = await endApprovalWindow(pool, s.roundId);
    assert.ok(Array.isArray(events));

    assert.deepEqual(await state(pool, s.transportId), {
      transport: { status: 'fallback', fallback_reason: 'approval_window', version: 2 },
      requests: [
        ['A', 'closed', 'expired_approval'],
        ['B', 'closed', 'expired_approval'],
        ['C', 'rejected', null],
        ['D', 'expired', null],
      ],
    });
    const { rows: history } = await pool.query(
      'SELECT from_status, to_status, event, reason FROM transport_status_history WHERE transport_id = $1',
      [s.transportId],
    );
    assert.deepEqual(history, [
      { from_status: 'requesting', to_status: 'fallback', event: 'APPROVAL_WINDOW_ENDED', reason: 'approval_window' },
    ]);

    // 병원 웹에는 '요청 종료'(request.changed), 팀에는 approval.expired와 transport.status
    assert.deepEqual(
      events.map((e) => [e.room, e.name]),
      [
        [`hospital:${s.hospitals.A}`, 'request.changed'],
        [`hospital:${s.hospitals.B}`, 'request.changed'],
        [`team:${s.teamId}`, 'approval.expired'],
        [`team:${s.teamId}`, 'transport.status'],
      ],
    );
    assert.equal(events[0].payload.status, 'closed');
    assert.equal(events[0].payload.closeReason, 'expired_approval');
    assert.equal(events[3].payload.reason, 'approval_window');
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

test('전화 확인 중이면 승인만 닫고 전화 화면은 그대로 둔다 (A9)', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'approved' }, '-1 second', 'phone_check');
    const events = await endApprovalWindow(pool, s.roundId);
    assert.ok(Array.isArray(events));
    assert.deepEqual(await state(pool, s.transportId), {
      transport: { status: 'phone_check', fallback_reason: null, version: 1 },
      requests: [['A', 'closed', 'expired_approval']],
    });
    assert.deepEqual(
      events.map((e) => e.name),
      ['request.changed', 'approval.expired'],
    );
  });
});

test('2분 타이머가 늦어 대기 요청이 남아 있으면 그것도 만료시킨다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'approved', B: 'waiting' });
    await endApprovalWindow(pool, s.roundId);
    assert.deepEqual((await state(pool, s.transportId)).requests, [
      ['A', 'closed', 'expired_approval'],
      ['B', 'expired', null],
    ]);
  });
});

test('두 번 실행돼도 결과가 같고 두 번째는 아무것도 알리지 않는다', async () => {
  await withSchemaPool(async (pool) => {
    const s = await setup(pool, { A: 'approved' });
    await endApprovalWindow(pool, s.roundId);
    const before = await state(pool, s.transportId);
    assert.deepEqual(await endApprovalWindow(pool, s.roundId), []);
    assert.deepEqual(await state(pool, s.transportId), before);
  });
});

test('이미 확정(이동 중)됐거나 새 회차가 시작됐으면 건드리지 않는다', async () => {
  await withSchemaPool(async (pool) => {
    const moving = await setup(pool, { A: 'confirmed', B: 'closed' }, '-1 second', 'moving');
    assert.deepEqual(await endApprovalWindow(pool, moving.roundId), []);
    assert.equal((await state(pool, moving.transportId)).transport.status, 'moving');

    // 지난 회차의 5분 작업이 새 회차(반경 넓히기) 진행 중인 이송 건을 바꾸면 안 된다
    const s = await setup(pool, { A: 'approved' });
    await pool.query(
      `INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
       VALUES ($1, 2, 30, now(), now() + interval '2 minutes', now() + interval '5 minutes')`,
      [s.transportId],
    );
    assert.deepEqual(await endApprovalWindow(pool, s.roundId), []);
    assert.equal((await state(pool, s.transportId)).transport.status, 'requesting');
  });
});

test('4분 해제 경보: 고르지 않은 유효 승인이 있을 때만 팀에 approval.expiring', async () => {
  await withSchemaPool(async (pool) => {
    // 아직 4분 전 (해제까지 90초)
    const early = await setup(pool, { A: 'approved' }, '90 seconds');
    assert.equal(await warnApprovalExpiring(pool, early.roundId), 'not_due');

    // 4분 지남 (해제까지 50초), 승인 1곳
    const s = await setup(pool, { A: 'approved', B: 'rejected' }, '50 seconds');
    const events = await warnApprovalExpiring(pool, s.roundId);
    assert.ok(Array.isArray(events));
    assert.deepEqual(
      events.map((e) => [e.room, e.name]),
      [[`team:${s.teamId}`, 'approval.expiring']],
    );
    assert.deepEqual(Object.keys(events[0].payload).sort(), ['releaseAt', 'transportId']);
    // 경보는 상태를 바꾸지 않는다
    assert.equal((await state(pool, s.transportId)).requests[0][1], 'approved');

    // 승인이 없으면 보내지 않는다
    const none = await setup(pool, { A: 'rejected' }, '50 seconds');
    assert.deepEqual(await warnApprovalExpiring(pool, none.roundId), []);

    // 이미 예비 추천이면 보내지 않는다
    const fallback = await setup(pool, { A: 'approved' }, '50 seconds', 'fallback');
    assert.deepEqual(await warnApprovalExpiring(pool, fallback.roundId), []);
  });
});
