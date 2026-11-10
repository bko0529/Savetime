// SFR-158(도착 환자 수용 불가) 인수 기준을 임시 DB·실제 Redis 로 확인한다. 실시간 이벤트는 event_log 기록으로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { addParamedic } from '../../testing/auth.js';
import { withRequestApp, type RequestHarness } from '../../testing/requestApp.js';
import { messageFor } from '../push/dispatch.js';
import { inheritedExclusions } from '../team/prevPatient.js';

let seq = 0;

// 우리 병원에 도착한 지 minutesAgo 분 된 이송 건 (대원 1명 팀). status 를 바꾸면 아직 도착 전도 만든다
async function arrivedAt(
  pool: pg.Pool,
  hospitalId: string,
  minutesAgo: number,
  { status = 'arrived' }: { status?: 'arrived' | 'confirmed' } = {},
): Promise<{ transportId: string; teamId: string; requestId: number }> {
  const paramedicId = await addParamedic(pool, { loginId: `p${randomBytes(3).toString('hex')}` });
  const { rows: teams } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ($2, 'qr', $1) RETURNING id`,
    [paramedicId, String(3000 + (seq += 1))],
  );
  const teamId = teams[0].id;
  await pool.query(
    "INSERT INTO team_member (team_id, paramedic_id, role) VALUES ($1, $2, 'driver')",
    [teamId, paramedicId],
  );
  const transportId = randomUUID();
  const arrived = status === 'arrived';
  await pool.query(
    `INSERT INTO transport (id, team_id, status, location_consent, confirmed_hospital_id, departed_at, arrived_at)
     VALUES ($1, $2, $3, true, $4, now() - interval '30 minutes',
             CASE WHEN $5 THEN now() - make_interval(mins => $6) END)`,
    [transportId, teamId, arrived ? 'arrived' : 'moving', hospitalId, arrived, minutesAgo],
  );
  const { rows: rounds } = await pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() - interval '25 minutes', now() - interval '22 minutes') RETURNING id`,
    [transportId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_request (round_id, hospital_id, status, arrived_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() - make_interval(mins => $5) END) RETURNING id`,
    [rounds[0].id, hospitalId, status, arrived, minutesAgo],
  );
  return { transportId, teamId, requestId: Number(rows[0].id) };
}

async function deskOnShift(h: RequestHarness, name = '접수대'): Promise<string> {
  const cookie = await h.registerPc(name);
  assert.equal((await h.post('/hw/shifts', cookie, { staffName: '박서연' })).status, 201);
  return cookie;
}

async function eventsOf(pool: pg.Pool) {
  const { rows } = await pool.query<{
    room: string;
    name: string;
    payload: Record<string, unknown>;
  }>('SELECT room, name, payload FROM event_log ORDER BY seq');
  return rows;
}

const requestRow = async (pool: pg.Pool, id: number) =>
  (
    await pool.query(
      'SELECT status, reason, reason_text, version FROM hospital_request WHERE id = $1',
      [id],
    )
  ).rows[0];

test("도착 2분 된 환자를 '수용 불가'(해당 전문의 부재)로 누르면 대원 앱에 경보와 사유가 가고, 다음 이송에서 이 병원이 빠진다 (SFR-158 인수 기준)", async () => {
  await withRequestApp(async (h) => {
    const desk = await deskOnShift(h);
    const { transportId, teamId, requestId } = await arrivedAt(h.pool, h.hospitalId, 2);

    const res = await h.post(`/hw/requests/${requestId}/unacceptable`, desk, {
      version: 1,
      reason: 'no_specialist',
    });
    assert.equal(res.status, 204);
    assert.deepEqual(await requestRow(h.pool, requestId), {
      status: 'unacceptable',
      reason: 'no_specialist',
      reason_text: null,
      version: 2,
    });
    // 이송 건은 '도착' 그대로 (수용 불가는 병원 요청 상태만 바꾼다)
    const { rows: t } = await h.pool.query('SELECT status FROM transport WHERE id = $1', [
      transportId,
    ]);
    assert.equal(t[0].status, 'arrived');

    // 대원 앱 경보: 병원 이름 + 사유 코드 (앱이 'A병원 수용 불가 · 해당 전문의 부재'로 보여 준다)
    const events = await eventsOf(h.pool);
    const alert = events.find((e) => e.name === 'transport.unacceptable')!;
    assert.equal(alert.room, `team:${teamId}`);
    assert.deepEqual(alert.payload, {
      transportId,
      hospitalName: 'A병원',
      reason: 'no_specialist',
    });
    // 같은 병원 다른 PC 화면도 바뀐다
    assert.deepEqual(
      events.filter((e) => e.room === `hospital:${h.hospitalId}`).map((e) => e.name),
      ['request.changed', 'incoming.updated'],
    );
    // 앱이 화면에 안 보이면 푸시: 잠금 화면 문구에도 병원 이름·사유만
    const push = await messageFor(h.pool, {
      seq: 1,
      room: alert.room,
      name: alert.name,
      entityVersion: null,
      payload: alert.payload as Record<string, string>,
      occurredAt: new Date(),
    });
    assert.equal(push?.body, 'A병원 수용 불가 · 해당 전문의 부재 · 다시 요청해 주세요');

    // 거절 원장에 출처 '수용 불가' 1줄 (승인 취소율 통계에 함께 센다, SFR-106)
    const { rows: rej } = await h.pool.query('SELECT source, reason FROM rejection_record');
    assert.deepEqual(rej, [{ source: 'unacceptable', reason: 'no_specialist' }]);
    // 직전 건을 이어 쓰는 다음 이송에서 이 병원을 뺀다 (SFR-157)
    const inherited = await inheritedExclusions(h.pool, teamId, transportId);
    assert.deepEqual(inherited?.hospitalIds, [h.hospitalId]);
  });
});

test("도착 11분 된 환자는 목록에서 '수용 불가'를 누를 수 없고, API 도 막힌다 (SFR-158 인수 기준)", async () => {
  await withRequestApp(async (h) => {
    const desk = await deskOnShift(h);
    const { requestId } = await arrivedAt(h.pool, h.hospitalId, 11);

    const list = await h.get('/hw/incoming', desk);
    const item = list.body.items.find((i: { id: number }) => i.id === requestId);
    assert.equal(item.canMarkUnacceptable, false, '화면에 버튼이 없다');

    const res = await h.post(`/hw/requests/${requestId}/unacceptable`, desk, {
      version: 1,
      reason: 'er_bed',
    });
    assert.equal(res.body.error.code, 'WINDOW_PASSED');
    assert.equal((await requestRow(h.pool, requestId)).status, 'arrived');
    assert.deepEqual(await eventsOf(h.pool), []);
  });
});

test('수용 불가: 사유·기타 글·version·근무·도착 전·다른 병원을 확인한다', async () => {
  await withRequestApp(async (h) => {
    const desk = await deskOnShift(h);
    const { requestId } = await arrivedAt(h.pool, h.hospitalId, 2);
    const post = (body: object, cookie = desk, id = requestId) =>
      h.post(`/hw/requests/${id}/unacceptable`, cookie, body);

    assert.equal((await post({ version: 1 })).body.error.code, 'REASON_REQUIRED');
    assert.equal((await post({ version: 1, reason: 'etc' })).body.error.code, 'REASON_REQUIRED');
    assert.equal((await post({ reason: 'er_bed' })).body.error.code, 'VERSION_REQUIRED');
    assert.equal(
      (await post({ version: 0, reason: 'er_bed' })).body.error.code,
      'VERSION_CONFLICT',
    );
    const idle = await h.registerPc('야간 PC');
    assert.equal(
      (await post({ version: 1, reason: 'er_bed' }, idle)).body.error.code,
      'SHIFT_REQUIRED',
    );

    // 아직 도착 전(이동 중)이면 수용 불가가 아니라 승인 취소를 써야 한다
    const moving = await arrivedAt(h.pool, h.hospitalId, 0, { status: 'confirmed' });
    const early = await post({ version: 1, reason: 'er_bed' }, desk, moving.requestId);
    assert.equal(early.body.error.code, 'INVALID_TRANSITION');

    // 다른 병원 요청은 있는지조차 알려 주지 않는다
    const { rows: other } = await h.pool.query<{ id: string }>(
      "INSERT INTO hospital (public_id, name, lat, lng) VALUES ('H9', 'B병원', 36.8, 127.1) RETURNING id",
    );
    const theirs = await arrivedAt(h.pool, other[0].id, 2);
    assert.equal(
      (await post({ version: 1, reason: 'er_bed' }, desk, theirs.requestId)).status,
      404,
    );

    // 기타는 글과 함께면 된다. 글은 병원 요청에만 두고 대원 앱 이벤트에는 넣지 않는다
    const ok = await post({ version: 1, reason: 'etc', etcText: '감염 격리실 없음' });
    assert.equal(ok.status, 204);
    assert.deepEqual(await requestRow(h.pool, requestId), {
      status: 'unacceptable',
      reason: 'etc',
      reason_text: '감염 격리실 없음',
      version: 2,
    });
    assert.doesNotMatch(JSON.stringify(await eventsOf(h.pool)), /감염 격리실/);
    // 두 번 누르면 이미 수용 불가라 막힌다
    assert.equal(
      (await post({ version: 2, reason: 'er_bed' })).body.error.code,
      'INVALID_TRANSITION',
    );
  });
});
