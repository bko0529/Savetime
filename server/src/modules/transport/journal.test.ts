// SFR-164 구급활동일지 초안 인수 기준을 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, login, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';

const post = (ctx: AuthContext, token: string, path: string, body: object) =>
  request(appFor(ctx)).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
const draft = (ctx: AuthContext, token: string, transportId: string) =>
  request(appFor(ctx))
    .get(`/api/v1/transports/${transportId}/journal-draft`)
    .set('Authorization', `Bearer ${token}`);

// B병원으로 확정 → 도착. 거리는 위치 기록이 있었던 것처럼 넣는다
async function arriveAtB(ctx: AuthContext, s: Scene, distanceM: number | null = 6200) {
  const confirmed = await post(ctx, s.kim, `/transports/${s.transportId}/confirm`, {
    hospitalRequestId: s.req['B병원'],
    version: 1,
  }).set('Idempotency-Key', randomUUID());
  assert.equal(confirmed.status, 200);
  const arrived = await post(ctx, s.kim, `/transports/${s.transportId}/arrive`, {
    method: 'button',
    version: confirmed.body.version,
  });
  assert.equal(arrived.status, 200);
  await ctx.pool.query('UPDATE transport SET distance_m = $2 WHERE id = $1', [
    s.transportId,
    distanceM,
  ]);
}

test('도착한 이송 건: 출발·도착 시각·거리·의식·혈압·이송 기관이 채워지고 환자 성명·주소 칸은 없다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    // 현장 평가: 의식 V, 혈압 150/90 (SFR-108)
    await ctx.pool.query(
      `UPDATE assessment SET sex = 'M', age_band = '60s', consciousness = 'verbal', bp = '150/90',
              pulse = 88, resp = 18, spo2 = 96, temp = 36.8, glucose = 140, history = '고혈압',
              ktas = 2, onset = '30분 전'
        WHERE transport_id = $1`,
      [s.transportId],
    );
    // D병원은 응급실 병상 부족으로 거절, 잠시 요청 중지 자동 거절은 빠져야 한다
    await ctx.pool.query(
      `UPDATE hospital_request SET status = 'rejected', reason = 'er_bed', responded_at = now()
        WHERE id = $1`,
      [s.req['D병원']],
    );
    await arriveAtB(ctx, s);

    const res = await draft(ctx, s.lee, s.transportId);
    assert.equal(res.status, 200);
    const { rows } = await ctx.pool.query<{ departed_at: Date; arrived_at: Date }>(
      'SELECT departed_at, arrived_at FROM transport WHERE id = $1',
      [s.transportId],
    );
    assert.deepEqual(res.body, {
      transportId: s.transportId,
      agencyName: '테스트소방서',
      safetyCenter: '테스트안전센터',
      crew: [
        { name: '김도윤', rank: '소방교', role: 'driver' },
        { name: '김도윤', rank: '소방교', role: 'care' },
      ],
      departedAt: rows[0].departed_at.toISOString(),
      arrivedAt: rows[0].arrived_at.toISOString(),
      distanceKm: 6.2,
      sex: 'M',
      ageBand: '60s',
      chiefComplaint: '갑작스러운 두통',
      onsetAt: '30분 전',
      consciousness: 'V',
      vitals: { sbp: 150, dbp: 90, pulse: 88, resp: 18, temp: 36.8, spo2: 96, glucose: 140 },
      history: '고혈압',
      ktas: 2,
      hospitalName: 'B병원',
      reTransferReasons: [{ hospitalName: 'D병원', reason: 'er_bed' }],
      notTransportedReason: null,
      notTransportedText: null,
    });
    // 환자 식별정보 칸은 서버 응답에 아예 없다 (DAR-015)
    for (const key of ['patientName', 'name', 'address', 'phone', 'birthDate']) {
      assert.equal(key in res.body, false, key);
    }
  });
});

test("이송을 취소하며 '이송 거부'를 고르면 미이송 사유가 채워지고, 이송 기관은 비어 있다", async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const cancelled = await post(ctx, s.kim, `/transports/${s.transportId}/cancel`, {
      version: 1,
      notTransportedReason: 'refused',
    });
    assert.equal(cancelled.status, 200);

    const res = await draft(ctx, s.kim, s.transportId);
    assert.equal(res.status, 200);
    assert.equal(res.body.notTransportedReason, 'refused');
    assert.equal(res.body.hospitalName, null);
    assert.equal(res.body.arrivedAt, null);
  });
});

test("취소 사유 '기타'는 글을 함께 받고, 기타가 아닌데 글만 보내면 400이다", async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const bad = await post(ctx, s.kim, `/transports/${s.transportId}/cancel`, {
      version: 1,
      notTransportedReason: 'refused',
      notTransportedText: '보호자 요청',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
    const wrong = await post(ctx, s.kim, `/transports/${s.transportId}/cancel`, {
      version: 1,
      notTransportedReason: 'unknown',
    });
    assert.equal(wrong.status, 400);

    const ok = await post(ctx, s.kim, `/transports/${s.transportId}/cancel`, {
      version: 1,
      notTransportedReason: 'etc',
      notTransportedText: '보호자 요청',
    });
    assert.equal(ok.status, 200);
    const res = await draft(ctx, s.kim, s.transportId);
    assert.deepEqual(
      [res.body.notTransportedReason, res.body.notTransportedText],
      ['etc', '보호자 요청'],
    );
  });
});

test('사유 없이 취소해도 되고(빈칸), 서버가 끝낸 취소는 system_end 다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const cancelled = await post(ctx, s.kim, `/transports/${s.transportId}/cancel`, { version: 1 });
    assert.equal(cancelled.status, 200);
    assert.equal((await draft(ctx, s.kim, s.transportId)).body.notTransportedReason, null);

    await ctx.pool.query("UPDATE transport SET cancel_reason = 'auto_inactive' WHERE id = $1", [
      s.transportId,
    ]);
    assert.equal((await draft(ctx, s.kim, s.transportId)).body.notTransportedReason, 'system_end');
  });
});

test('통신이 끊긴 채 도착해 위치가 없으면 거리 칸은 비어 있다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await arriveAtB(ctx, s, null);
    const res = await draft(ctx, s.kim, s.transportId);
    assert.equal(res.status, 200);
    assert.equal(res.body.distanceKm, null);
  });
});

test('끝나기 전이면 409, 끝나고 10분이 지나면 404 (DB 시각 기준)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const early = await draft(ctx, s.kim, s.transportId);
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'TRANSPORT_NOT_ENDED');

    await arriveAtB(ctx, s);
    // 이송이 30분 전에 시작해 9분 전에 끝난 것처럼 시각을 당긴다 (팀 합류도 그 전으로)
    await ctx.pool.query(
      `UPDATE team_member SET joined_at = now() - interval '1 hour'
        WHERE team_id = (SELECT team_id FROM transport WHERE id = $1)`,
      [s.transportId],
    );
    await ctx.pool.query(
      `UPDATE transport SET created_at = now() - interval '30 minutes',
              arrived_at = now() - interval '9 minutes' WHERE id = $1`,
      [s.transportId],
    );
    assert.equal((await draft(ctx, s.kim, s.transportId)).status, 200);
    await ctx.pool.query(
      "UPDATE transport SET arrived_at = now() - interval '11 minutes' WHERE id = $1",
      [s.transportId],
    );
    const late = await draft(ctx, s.kim, s.transportId);
    assert.equal(late.status, 404);
    assert.equal(late.body.error.code, 'NOT_FOUND');
  });
});

test('다른 팀 대원과 이송이 끝난 뒤 팀에 들어온 대원은 볼 수 없다 (404)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await arriveAtB(ctx, s);
    const other = await login(ctx, 'park01');
    assert.equal((await draft(ctx, other, s.transportId)).status, 404);

    // 도착 뒤 팀에 들어온 대원: 구급대원 칸에도 없고 볼 수도 없다
    const late = await login(ctx, 'choi01');
    const { rows } = await ctx.pool.query<{ code: string }>(
      `SELECT t.code FROM team t JOIN transport tr ON tr.team_id = t.id WHERE tr.id = $1`,
      [s.transportId],
    );
    const joined = await post(ctx, late, '/teams/join', { code: rows[0].code, role: 'care' });
    assert.equal(joined.status, 200);
    assert.equal((await draft(ctx, late, s.transportId)).status, 404);
    assert.equal((await draft(ctx, s.kim, s.transportId)).body.crew.length, 2);

    assert.equal((await draft(ctx, s.kim, 'not-a-uuid')).status, 404);
  });
});
