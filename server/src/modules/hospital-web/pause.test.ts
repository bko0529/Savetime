// SFR-139 인수 기준(잠시 요청 중지: 대기 요청 한꺼번에 거절, 승인은 유지, 다시 받기, 2시간 알림)을 임시 DB·실제 Redis 로 확인한다.
// 중지된 병원이 요청 대상에서 빠지는 것은 transport/create.test.ts 가 requests_paused 로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { pino } from 'pino';
import { addParamedic } from '../../testing/auth.js';
import { addHospitalRequest } from '../../testing/hospitalRequests.js';
import { withRequestApp, type RequestHarness as Harness } from '../../testing/requestApp.js';
import { remindLongPauses } from './pause.js';

const logger = pino({ level: 'silent' });

async function onShift(h: Harness, pcName = '접수대', staffName = '박서연'): Promise<string> {
  const cookie = await h.registerPc(pcName);
  assert.equal((await h.post('/hw/shifts', cookie, { staffName })).status, 201);
  return cookie;
}

// 요청의 이송 건을 팀에 붙인다 (팀 방 이벤트를 보려고)
async function giveTeam(pool: pg.Pool, requestId: number, loginId: string): Promise<string> {
  const paramedicId = await addParamedic(pool, { loginId });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ($2, 'qr', $1) RETURNING id`,
    [paramedicId, String(2000 + requestId)],
  );
  await pool.query(
    `UPDATE transport SET team_id = $2
      WHERE id = (SELECT r.transport_id FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
                   WHERE hr.id = $1)`,
    [requestId, rows[0].id],
  );
  return rows[0].id;
}

async function eventsOf(pool: pg.Pool) {
  const { rows } = await pool.query<{
    room: string;
    name: string;
    payload: Record<string, unknown>;
  }>('SELECT room, name, payload FROM event_log ORDER BY seq');
  return rows;
}

async function statusOf(pool: pg.Pool, id: number) {
  const { rows } = await pool.query(
    'SELECT status, reason, in_stats FROM hospital_request WHERE id = $1',
    [id],
  );
  return rows[0];
}

test('중지하면 대기 요청은 모두 거절(요청 중지)·통계 제외·제외 병원 아님, 승인한 요청은 그대로 (SFR-139)', async () => {
  await withRequestApp(async (h) => {
    const cookie = await onShift(h);
    const w1 = await addHospitalRequest(h.pool, h.hospitalId);
    const w2 = await addHospitalRequest(h.pool, h.hospitalId);
    const approved = await addHospitalRequest(h.pool, h.hospitalId, { status: 'approved' });
    // 2분이 지난 대기 요청은 만료 타이머 몫이라 건드리지 않는다
    const late = await addHospitalRequest(h.pool, h.hospitalId, { respondIn: '-1 second' });
    const teamId = await giveTeam(h.pool, w1, 'kim01');

    const res = await h.put('/hw/pause', cookie, { paused: true });
    assert.equal(res.status, 204);

    for (const id of [w1, w2]) {
      assert.deepEqual(await statusOf(h.pool, id), {
        status: 'rejected',
        reason: 'paused',
        in_stats: false,
      });
    }
    assert.equal((await statusOf(h.pool, approved)).status, 'approved');
    assert.equal((await statusOf(h.pool, late)).status, 'waiting');
    const { rows: excluded } = await h.pool.query(
      'SELECT count(*)::int AS n FROM excluded_hospital',
    );
    assert.equal(excluded[0].n, 0);

    const { rows: hospital } = await h.pool.query(
      'SELECT requests_paused, paused_at IS NOT NULL AS has_at FROM hospital WHERE id = $1',
      [h.hospitalId],
    );
    assert.deepEqual(hospital[0], { requests_paused: true, has_at: true });

    // 대원 앱에 바로 '거절 · 요청 중지', 남은 요청이 없으니 예비 추천으로. 병원 모든 PC 에 pause_changed
    const logged = await eventsOf(h.pool);
    const team = logged.filter((e) => e.room === `team:${teamId}`);
    assert.deepEqual(
      team.map((e) => e.name),
      ['request.rejected', 'transport.status'],
    );
    assert.equal(team[0].payload.reason, 'paused');
    assert.equal(team[1].payload.status, 'fallback');
    const changed = logged.filter((e) => e.name === 'hospital.pause_changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].room, `hospital:${h.hospitalId}`);
    assert.equal(changed[0].payload.paused, true);
    assert.equal(changed[0].payload.byPcName, '접수대');
    assert.equal(changed[0].payload.byName, '박서연');
    // 이벤트에 환자 정보 없음 (규칙 5)
    assert.doesNotMatch(JSON.stringify(logged), /흉통/);

    // 세션에도 중지 상태가 보인다
    const session = await h.get('/hw/session', cookie);
    assert.equal(session.body.paused, true);
    assert.ok(Date.parse(session.body.pausedAt));
  });
});

test('다시 받기를 누르면 중지가 풀린다. 같은 상태로 또 눌러도 아무 일 없다', async () => {
  await withRequestApp(async (h) => {
    const cookie = await onShift(h);
    const other = await onShift(h, '처치실', '김도윤');
    assert.equal((await h.put('/hw/pause', cookie, { paused: true })).status, 204);
    // 다른 PC 가 또 중지를 눌러도 이벤트가 두 번 나가지 않는다
    assert.equal((await h.put('/hw/pause', other, { paused: true })).status, 204);
    assert.equal(
      (await eventsOf(h.pool)).filter((e) => e.name === 'hospital.pause_changed').length,
      1,
    );

    // 중지 중에 들어와 있던 대기 요청(중지 직전 생성 등)은 다시 받기로 건드리지 않는다
    const waiting = await addHospitalRequest(h.pool, h.hospitalId);
    assert.equal((await h.put('/hw/pause', other, { paused: false })).status, 204);
    assert.equal((await statusOf(h.pool, waiting)).status, 'waiting');

    const { rows } = await h.pool.query(
      'SELECT requests_paused, paused_at FROM hospital WHERE id = $1',
      [h.hospitalId],
    );
    assert.deepEqual(rows[0], { requests_paused: false, paused_at: null });
    const last = (await eventsOf(h.pool)).at(-1)!;
    assert.equal(last.name, 'hospital.pause_changed');
    assert.equal(last.payload.paused, false);
    assert.equal(last.payload.byPcName, '처치실');
  });
});

test('근무 전 PC 는 중지할 수 없고, paused 가 빠지면 400', async () => {
  await withRequestApp(async (h) => {
    const noShift = await h.registerPc('접수대');
    const res = await h.put('/hw/pause', noShift, { paused: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SHIFT_REQUIRED');
    const cookie = await onShift(h, '처치실');
    assert.equal((await h.put('/hw/pause', cookie, {})).status, 400);
    const { rows } = await h.pool.query('SELECT requests_paused FROM hospital WHERE id = $1', [
      h.hospitalId,
    ]);
    assert.equal(rows[0].requests_paused, false);
  });
});

test('중지 2시간째에 한 번만 알린다. 다시 중지하면 새로 센다', async () => {
  await withRequestApp(async (h) => {
    const cookie = await onShift(h);
    await h.put('/hw/pause', cookie, { paused: true });

    // 아직 2시간 전: 알림 없음
    assert.deepEqual(await remindLongPauses(h.pool, h.redis, logger), []);

    await h.pool.query("UPDATE hospital SET paused_at = now() - interval '2 hours' WHERE id = $1", [
      h.hospitalId,
    ]);
    const first = await remindLongPauses(h.pool, h.redis, logger);
    assert.equal(first.length, 1);
    assert.equal(first[0].room, `hospital:${h.hospitalId}`);
    assert.equal(first[0].name, 'hospital.pause_reminder');
    // 1분 뒤 다시 훑어도 또 보내지 않는다 (서버 2대여도 Redis 로 한 번)
    assert.deepEqual(await remindLongPauses(h.pool, h.redis, logger), []);

    // 풀었다가 다시 중지하면 새 중지로 센다
    await h.put('/hw/pause', cookie, { paused: false });
    assert.deepEqual(await remindLongPauses(h.pool, h.redis, logger), []);
    await h.put('/hw/pause', cookie, { paused: true });
    await h.pool.query("UPDATE hospital SET paused_at = now() - interval '3 hours' WHERE id = $1", [
      h.hospitalId,
    ]);
    assert.equal((await remindLongPauses(h.pool, h.redis, logger)).length, 1);
  });
});
