// SFR-157 직전 환자 정보 채워두기 · DAR-013 종료 10분 뒤 팀 연결 끊기 · 직전 건 수용 불가 병원 이어받기를 임시 DB로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, login, ORIGIN, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';
import { releaseEndedTransports } from './prevPatient.js';

const logger = pino({ level: 'silent' });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const getDraft = (ctx: AuthContext, token: string) =>
  request(appFor(ctx)).get('/api/v1/teams/current/draft').set(auth(token));
const patchDraft = (ctx: AuthContext, token: string, changes: object) =>
  request(appFor(ctx))
    .patch('/api/v1/teams/current/draft')
    .set(auth(token))
    .send({ baseVersion: 0, changes });

// 이송 중 팀이 작성 중 정보에 환자 정보를 넣고, B병원으로 출발해 도착한다
async function arrivedWithPatient(ctx: AuthContext): Promise<Scene> {
  const s = await scene(ctx);
  assert.equal(
    (await patchDraft(ctx, s.lee, { chiefComplaint: '갑작스러운 두통', spo2: 93 })).status,
    200,
  );
  const confirmed = await request(appFor(ctx))
    .post(`/api/v1/transports/${s.transportId}/confirm`)
    .set(auth(s.kim))
    .set('Idempotency-Key', randomUUID())
    .send({ hospitalRequestId: s.req['B병원'], version: 1 });
  assert.equal(confirmed.status, 200);
  const arrived = await request(appFor(ctx))
    .post(`/api/v1/transports/${s.transportId}/arrive`)
    .set(auth(s.kim))
    .send({ method: 'menu', version: 2 });
  assert.equal(arrived.status, 200);
  return s;
}

// 도착이 m분 전이었던 것으로 맞춘다. 작성 중 정보는 그보다 1분 전에 고친 것으로 (이송 중에 입력)
async function endedMinutesAgo(pool: pg.Pool, transportId: string, minutes: number) {
  await pool.query(
    `UPDATE transport SET arrived_at = now() - make_interval(mins => $2) WHERE id = $1`,
    [transportId, minutes],
  );
  await pool.query(`UPDATE team_draft SET updated_at = now() - make_interval(mins => $1)`, [
    minutes + 1,
  ]);
}

async function newTransport(ctx: AuthContext, token: string, body: object) {
  return request(appFor(ctx))
    .post('/api/v1/transports')
    .set(auth(token))
    .send({
      id: randomUUID(),
      radiusKm: 20,
      location: ORIGIN,
      locationConsent: true,
      assessment: { chiefComplaint: '갑작스러운 두통', spo2: 93 },
      ...body,
    });
}

test('도착 3분 뒤 입력 화면: 직전 환자 정보가 채워져 있고 바로 요청할 수 있다 (SFR-157 인수 기준 1)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await arrivedWithPatient(ctx);
    await endedMinutesAgo(ctx.pool, s.transportId, 3);

    const res = await getDraft(ctx, s.kim);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.assessment, { chiefComplaint: '갑작스러운 두통', spo2: 93 });
    assert.equal(res.body.prefilledFromTransportId, s.transportId);
    // 끝난 시각 + 10분 (지금부터 약 7분 뒤)
    const left = Date.parse(res.body.prefillExpiresAt) - Date.now();
    assert.ok(left > 6 * 60_000 && left <= 7 * 60_000 + 5_000, `남은 시간 ${left}ms`);

    // 응급실 앞에서 B병원이 수용 불가 → 직전 건 ID 와 함께 바로 다시 요청하면 B병원은 빠진다 (SFR-086)
    await ctx.pool.query(`UPDATE hospital_request SET status = 'unacceptable' WHERE id = $1`, [
      s.req['B병원'],
    ]);
    const again = await newTransport(ctx, s.lee, { prevTransportId: s.transportId });
    assert.equal(again.status, 201);
    assert.deepEqual(
      again.body.requests.map((r: { hospitalName: string }) => r.hospitalName).sort(),
      ['C병원', 'D병원'],
    );
    const { rows } = await ctx.pool.query(
      `SELECT t.prev_transport_id, e.reason, h.name
         FROM transport t JOIN excluded_hospital e ON e.transport_id = t.id JOIN hospital h ON h.id = e.hospital_id
        WHERE t.id = $1`,
      [again.body.id],
    );
    assert.deepEqual(rows, [
      { prev_transport_id: s.transportId, reason: 'unacceptable_prev', name: 'B병원' },
    ]);

    // 새 이송이 시작됐으니 더는 '직전 환자 정보'가 아니다
    assert.equal((await getDraft(ctx, s.kim)).body.prefilledFromTransportId, null);
  });
});

test('끝난 지 11분: 빈 입력 화면, 주기 작업이 팀 연결을 끊고 작성 중 정보를 비운다 (SFR-157 인수 기준 2, DAR-013)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await arrivedWithPatient(ctx);
    await endedMinutesAgo(ctx.pool, s.transportId, 11);

    // 주기 작업이 돌기 전에 열어도 빈 화면
    const before = await getDraft(ctx, s.kim);
    assert.deepEqual(before.body.assessment, {});
    assert.equal(before.body.version, 0);
    assert.equal(before.body.prefilledFromTransportId, null);

    const events = await releaseEndedTransports(ctx.pool, logger);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'draft.updated');
    assert.equal(events[0].payload.byName, null);
    assert.deepEqual(events[0].payload.fields, []);

    const { rows } = await ctx.pool.query(
      `SELECT t.team_id, t.status, (SELECT count(*)::int FROM team_draft) AS drafts
         FROM transport t WHERE t.id = $1`,
      [s.transportId],
    );
    // 이송 건 기록은 남고 팀 연결만 끊긴다
    assert.deepEqual(rows[0], { team_id: null, status: 'arrived', drafts: 0 });
    // 한 번 정리한 건은 다시 보지 않는다
    assert.deepEqual(await releaseEndedTransports(ctx.pool, logger), []);
    // 팀 연결이 끊긴 건은 일지 초안도 볼 수 없다 (10분)
    const journal = await request(appFor(ctx))
      .get(`/api/v1/transports/${s.transportId}/journal-draft`)
      .set(auth(s.kim));
    assert.equal(journal.status, 404);
  });
});

test('10분이 지났는데 정리 전에 고치면 직전 환자 칸 위에 합치지 않고 새로 시작한다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await arrivedWithPatient(ctx);
    await endedMinutesAgo(ctx.pool, s.transportId, 11);
    const res = await patchDraft(ctx, s.lee, { chiefComplaint: '복통' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.assessment, { chiefComplaint: '복통' });
  });
});

test("'지우기'를 누르면 모든 항목이 비워진다 (SFR-157 인수 기준 3)", async () => {
  await withAuthContext(async (ctx) => {
    const s = await arrivedWithPatient(ctx);
    await endedMinutesAgo(ctx.pool, s.transportId, 2);
    assert.equal((await getDraft(ctx, s.kim)).body.prefilledFromTransportId, s.transportId);

    const cleared = await request(appFor(ctx))
      .delete('/api/v1/teams/current/draft')
      .set(auth(s.lee));
    assert.equal(cleared.status, 204);
    const res = await getDraft(ctx, s.kim);
    assert.deepEqual(res.body.assessment, {});
    assert.equal(res.body.prefilledFromTransportId, null);
  });
});

test('끝난 뒤 고친 작성 중 정보는 직전 환자 정보가 아니고, 10분이 지나도 지우지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await arrivedWithPatient(ctx);
    await endedMinutesAgo(ctx.pool, s.transportId, 11);
    // 끝난 뒤(5분 전) 다음 환자를 입력함
    await ctx.pool.query(`UPDATE team_draft SET updated_at = now() - interval '5 minutes'`);

    const res = await getDraft(ctx, s.kim);
    assert.equal(res.body.prefilledFromTransportId, null);
    assert.equal(res.body.assessment.spo2, 93);

    assert.deepEqual(await releaseEndedTransports(ctx.pool, logger), []);
    const { rows } = await ctx.pool.query(
      'SELECT (SELECT count(*)::int FROM team_draft) AS drafts, team_id FROM transport WHERE id = $1',
      [s.transportId],
    );
    assert.deepEqual(rows[0], { drafts: 1, team_id: null });
  });
});

test('다른 팀 건·10분 지난 건은 제외 병원을 이어받지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await arrivedWithPatient(ctx);
    await ctx.pool.query(`UPDATE hospital_request SET status = 'unacceptable' WHERE id = $1`, [
      s.req['B병원'],
    ]);

    // 다른 팀이 이 건 ID 를 보내도 이어받지 않는다
    const park = await login(ctx, 'park01');
    await request(appFor(ctx)).post('/api/v1/teams').set(auth(park)).send({ role: 'driver' });
    const other = await newTransport(ctx, park, { prevTransportId: s.transportId });
    assert.equal(other.status, 201);
    assert.ok(
      other.body.requests.some((r: { hospitalName: string }) => r.hospitalName === 'B병원'),
    );

    // 우리 팀이라도 10분이 지났으면 이어받지 않는다
    await endedMinutesAgo(ctx.pool, s.transportId, 11);
    const late = await newTransport(ctx, s.kim, { prevTransportId: s.transportId });
    assert.equal(late.status, 201);
    assert.ok(late.body.requests.some((r: { hospitalName: string }) => r.hospitalName === 'B병원'));
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM excluded_hospital WHERE transport_id = ANY($1::uuid[])',
      [[other.body.id, late.body.id]],
    );
    assert.equal(rows[0].n, 0);
  });
});

test('요청 대상 미리보기도 직전 건 수용 불가 병원을 빼고 센다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await arrivedWithPatient(ctx);
    await ctx.pool.query(`UPDATE hospital_request SET status = 'unacceptable' WHERE id = $1`, [
      s.req['B병원'],
    ]);
    const preview = (prev?: string) =>
      request(appFor(ctx))
        .get('/api/v1/request-targets/preview')
        .query({
          lat: ORIGIN.lat,
          lng: ORIGIN.lng,
          radiusKm: 20,
          ...(prev ? { prevTransportId: prev } : {}),
        })
        .set(auth(s.kim));
    assert.equal((await preview()).body.count, 3);
    assert.equal((await preview(s.transportId)).body.count, 2);
  });
});
