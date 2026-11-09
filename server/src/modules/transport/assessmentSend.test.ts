// SFR-105 요청·이동 중 환자 정보 갱신 인수 기준을 임시 DB로 확인한다.
// 팀 작성 중 정보(SFR-114)를 고치고 '변경 사항 보내기'를 누르면 바뀐 칸만 병원에 알리고, 병원 웹은 바뀐 칸을 강조한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, login, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';
import { getRequestDetail, listRequests } from '../hospital-web/requests.js';

const api = (ctx: AuthContext) => request(appFor(ctx));
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function editDraft(ctx: AuthContext, token: string, changes: object) {
  const res = await api(ctx)
    .patch('/api/v1/teams/current/draft')
    .set(auth(token))
    .send({ baseVersion: 0, changes });
  assert.equal(res.status, 200);
}

const send = (ctx: AuthContext, s: Scene, body: object, token = s.lee) =>
  api(ctx).post(`/api/v1/transports/${s.transportId}/assessments`).set(auth(token)).send(body);

// 팀의 진행 중 이송 건 (팀원 누구나 같은 건)
async function transportView(ctx: AuthContext, s: Scene, token = s.kim) {
  const res = await api(ctx).get('/api/v1/transports/current').set(auth(token));
  assert.equal(res.status, 200);
  return res.body;
}

// 그 병원 PC(장면이 근무 시작해 둠)로 상세를 연다
async function detailAs(pool: pg.Pool, name: string, requestId: number) {
  const { rows } = await pool.query<{ hospital_id: string; pc_id: string }>(
    `SELECT h.id AS hospital_id, p.id AS pc_id FROM hospital h JOIN hospital_pc p ON p.hospital_id = h.id
      WHERE h.name = $1`,
    [name],
  );
  const pc = {
    pcId: Number(rows[0].pc_id),
    pcName: '접수대',
    hospitalId: Number(rows[0].hospital_id),
    hospitalName: name,
    licenseDaysLeft: 30,
  };
  return { pc, detail: await getRequestDetail(pool, pc, requestId) };
}

async function eventsSince(pool: pg.Pool, since: number) {
  const { rows } = await pool.query(
    'SELECT room, name, payload FROM event_log WHERE seq > $1 ORDER BY seq',
    [since],
  );
  return rows;
}

async function lastSeq(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query('SELECT coalesce(max(seq), 0)::int AS n FROM event_log');
  return rows[0].n;
}

test('이송 요청 직후에는 보낼 변경 사항이 0이고, 팀 작성 중 정보에 보낸 값이 들어 있다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const view = await transportView(ctx, s);
    assert.equal(view.lastSentAssessmentSeq, 1);
    assert.equal(view.pendingChanges, 0);
    const draft = await api(ctx).get('/api/v1/teams/current/draft').set(auth(s.lee));
    assert.equal(draft.body.assessment.chiefComplaint, '갑작스러운 두통');

    const nothing = await send(ctx, s, { baseSeq: 1 });
    assert.equal(nothing.status, 409);
    assert.equal(nothing.body.error.code, 'NOTHING_TO_SEND');
  });
});

test('이동 중 산소포화도 95 → 88: 목적지 병원 웹에서 88로 강조되고 전후 값·시각이 남는다 (SFR-105 인수 기준 1)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await editDraft(ctx, s.lee, { spo2: 95 });
    assert.equal((await send(ctx, s, { baseSeq: 1 })).status, 200);

    const confirmed = await api(ctx)
      .post(`/api/v1/transports/${s.transportId}/confirm`)
      .set(auth(s.kim))
      .set('Idempotency-Key', randomUUID())
      .send({ hospitalRequestId: s.req['B병원'], version: 1 });
    assert.equal(confirmed.status, 200);

    await editDraft(ctx, s.lee, { spo2: 88 });
    // 보내기 전: 팀원 누구나 같은 n, 병원 웹은 아직 95
    assert.equal((await transportView(ctx, s, s.kim)).pendingChanges, 1);
    assert.equal((await transportView(ctx, s, s.lee)).pendingChanges, 1);
    assert.equal((await detailAs(ctx.pool, 'B병원', s.req['B병원'])).detail.assessment.spo2, 95);

    const since = await lastSeq(ctx.pool);
    const res = await send(ctx, s, { baseSeq: 2 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { seq: 3, changedFields: ['spo2'] });

    const { detail } = await detailAs(ctx.pool, 'B병원', s.req['B병원']);
    assert.equal(detail.assessment.spo2, 88);
    assert.ok(detail.updatedFields.includes('spo2'));

    // 바뀌기 전후 값과 시각 (보낼 때마다 1행)
    const { rows } = await ctx.pool.query(
      'SELECT seq, spo2, sent_at IS NOT NULL AS has_at FROM assessment WHERE transport_id = $1 ORDER BY seq',
      [s.transportId],
    );
    assert.deepEqual(rows, [
      { seq: 1, spo2: null, has_at: true },
      { seq: 2, spo2: 95, has_at: true },
      { seq: 3, spo2: 88, has_at: true },
    ]);

    // 이동 중에는 목적지 병원(B)의 도착 예정에만. 팀에는 n = 0. 이벤트에 값은 없다
    const sent = await eventsSince(ctx.pool, since);
    assert.deepEqual(
      sent.map((e) => e.name),
      ['incoming.updated', 'assessment.sent'],
    );
    assert.deepEqual(sent[0].payload, { requestId: s.req['B병원'], changedFields: ['spo2'] });
    assert.equal(sent[1].payload.assessmentSeq, 3);
    assert.deepEqual(sent[1].payload.changedFields, ['spo2']);
    // 값(88·주 증상)은 이벤트에 없다: 칸이 정확히 이것뿐
    assert.deepEqual(Object.keys(sent[1].payload).sort(), [
      'assessmentSeq',
      'byName',
      'changedFields',
      'transportId',
    ]);
    assert.doesNotMatch(JSON.stringify(sent), /두통/);
    assert.equal((await transportView(ctx, s)).pendingChanges, 0);
  });
});

test('요청 중 의식 수준 변경: 대기·승인 병원에만 알리고 거절한 병원은 뺀다 (SFR-105 인수 기준 2)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    // B 승인 · C 거절 · D 대기
    await ctx.pool.query(
      `UPDATE hospital_request SET status = 'rejected', reason = 'er_bed' WHERE id = $1`,
      [s.req['C병원']],
    );
    await editDraft(ctx, s.lee, { consciousness: 'pain' });
    const since = await lastSeq(ctx.pool);

    const res = await send(ctx, s, { baseSeq: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.changedFields, ['consciousness']);
    const sent = await eventsSince(ctx.pool, since);
    const updated = sent.filter((e) => e.name === 'request.updated');
    assert.deepEqual(
      updated.map((e) => e.payload.requestId).sort(),
      [s.req['B병원'], s.req['D병원']].sort(),
    );

    // 대기 중인 D병원 목록·상세에 강조
    const { pc, detail } = await detailAs(ctx.pool, 'D병원', s.req['D병원']);
    assert.deepEqual(detail.updatedFields, ['consciousness']);
    assert.equal(detail.assessment.consciousness, 'pain');
    const list = await listRequests(ctx.pool, pc.hospitalId, { status: 'open', limit: 30 });
    assert.deepEqual(list.items[0].updatedFields, ['consciousness']);
  });
});

test('고치고 아직 안 보냈으면 병원 웹은 그대로, 앱에는 (2) (SFR-105 인수 기준 3)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await editDraft(ctx, s.lee, { bp: '90/60', pulse: 120 });
    assert.equal((await transportView(ctx, s)).pendingChanges, 2);
    const { detail } = await detailAs(ctx.pool, 'B병원', s.req['B병원']);
    assert.equal(detail.assessment.bp, null);
    assert.deepEqual(detail.updatedFields, []);
  });
});

test('누가 눌러도 한 번만: 같은 baseSeq 두 번째는 409, baseSeq 없음 400, 끝난 건 409, 남의 팀 404', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await editDraft(ctx, s.lee, { pulse: 110 });

    const noBase = await send(ctx, s, {});
    assert.equal(noBase.status, 400);
    assert.equal(noBase.body.error.code, 'VERSION_REQUIRED');

    // 두 팀원이 동시에 누름 → seq 는 하나만 는다
    const [a, b] = await Promise.all([
      send(ctx, s, { baseSeq: 1 }, s.kim),
      send(ctx, s, { baseSeq: 1 }, s.lee),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.error.code, 'VERSION_CONFLICT');
    assert.equal(loser.body.error.details.current.lastSentAssessmentSeq, 2);
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM assessment WHERE transport_id = $1',
      [s.transportId],
    );
    assert.equal(rows[0].n, 2);

    // 주 증상을 지운 채로는 보내지 않는다
    await editDraft(ctx, s.lee, { chiefComplaint: null });
    const noComplaint = await send(ctx, s, { baseSeq: 2 });
    assert.equal(noComplaint.status, 400);
    assert.deepEqual(noComplaint.body.error.details.fields, ['chiefComplaint']);

    const other = await login(ctx, 'park01');
    await api(ctx).post('/api/v1/teams').set(auth(other)).send({ role: 'driver' });
    assert.equal((await send(ctx, s, { baseSeq: 2 }, other)).status, 404);

    await ctx.pool.query(
      `UPDATE transport SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'user' WHERE id = $1`,
      [s.transportId],
    );
    const ended = await send(ctx, s, { baseSeq: 2 });
    assert.equal(ended.status, 409);
    assert.equal(ended.body.error.code, 'INVALID_TRANSITION');
    assert.equal(ended.body.error.details.current.pendingChanges, 0);
  });
});
