// SFR-099 통신 두절 중 기록 올리기 인수 기준을 임시 DB로 확인한다.
// 장면: 김도윤·이하준 한 팀이 B·C·D병원에 요청 (B·C 승인, D 대기). 예비 추천으로 바꿔서 오프라인 전화 확인을 재현한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { withAuthContext } from '../../testing/auth.js';
import { appFor, login, ORIGIN, scene, type Scene } from '../../testing/transportScene.js';
import type { AuthContext } from '../auth/session.js';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sync = (ctx: AuthContext, token: string, records: object[]) =>
  request(appFor(ctx)).post('/api/v1/transports/sync').set(auth(token)).send({ records });

async function hospitalIds(pool: pg.Pool): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ id: string; name: string }>('SELECT id, name FROM hospital');
  return Object.fromEntries(rows.map((r) => [r.name, Number(r.id)]));
}

// 2분이 지나 모두 만료돼 예비 추천이 된 상태 (서버에 유효 승인 없음)
async function toFallback(pool: pg.Pool, s: Scene) {
  await pool.query(`UPDATE hospital_request SET status = 'expired' WHERE id = ANY($1::bigint[])`, [
    Object.values(s.req),
  ]);
  await pool.query(
    `UPDATE transport SET status = 'fallback', fallback_reason = 'expired_no_approval' WHERE id = $1`,
    [s.transportId],
  );
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

test('오프라인 14:05 B병원 거절 → 14:06 C병원 수용이 그 순서로 반영돼 이동 중이 된다 (SFR-099 인수 기준 1)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await toFallback(ctx.pool, s);
    const h = await hospitalIds(ctx.pool);
    const rejectId = randomUUID();
    const acceptId = randomUUID();

    const res = await sync(ctx, s.kim, [
      {
        clientRecordId: rejectId,
        kind: 'phone_check',
        transportId: s.transportId,
        occurredAt: minutesAgo(5),
        hospitalId: h['B병원'],
        result: 'rejected',
        rejectReason: 'er_bed',
      },
      {
        clientRecordId: acceptId,
        kind: 'phone_check',
        transportId: s.transportId,
        occurredAt: minutesAgo(4),
        hospitalId: h['C병원'],
        result: 'accepted',
      },
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results, [
      { clientRecordId: rejectId, outcome: 'applied', code: null },
      { clientRecordId: acceptId, outcome: 'applied', code: null },
    ]);
    assert.equal(res.body.alert, false);
    assert.equal(res.body.transport.status, 'moving');

    // 발생 순서·단말 시각 그대로, 오프라인 표시
    const { rows } = await ctx.pool.query(
      `SELECT h.name, p.result, p.reject_reason, p.offline, p.client_record_id
         FROM phone_check p JOIN hospital h ON h.id = p.hospital_id
        WHERE p.transport_id = $1 ORDER BY p.created_at`,
      [s.transportId],
    );
    assert.deepEqual(rows, [
      {
        name: 'B병원',
        result: 'rejected',
        reject_reason: 'er_bed',
        offline: true,
        client_record_id: rejectId,
      },
      {
        name: 'C병원',
        result: 'accepted',
        reject_reason: null,
        offline: true,
        client_record_id: acceptId,
      },
    ]);
    const { rows: t } = await ctx.pool.query(
      `SELECT h.name AS confirmed, (SELECT count(*)::int FROM excluded_hospital e
                                      WHERE e.transport_id = t.id AND e.reason = 'phone_rejected') AS excluded
         FROM transport t JOIN hospital h ON h.id = t.confirmed_hospital_id WHERE t.id = $1`,
      [s.transportId],
    );
    assert.deepEqual(t[0], { confirmed: 'C병원', excluded: 1 });

    // 같은 기록을 다시 올려도(전송 성공을 못 받은 앱) 두 번 반영하지 않는다
    const again = await sync(ctx, s.kim, [
      {
        clientRecordId: acceptId,
        kind: 'phone_check',
        transportId: s.transportId,
        occurredAt: minutesAgo(4),
        hospitalId: h['C병원'],
        result: 'accepted',
      },
    ]);
    assert.equal(again.body.results[0].outcome, 'duplicate');
  });
});

test('오프라인에서 누른 도착을 다시 실행 후 올리면 도착으로 끝나고 단말 시각이 기록된다 (SFR-099 인수 기준 2)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const confirmed = await request(appFor(ctx))
      .post(`/api/v1/transports/${s.transportId}/confirm`)
      .set(auth(s.kim))
      .set('Idempotency-Key', randomUUID())
      .send({ hospitalRequestId: s.req['B병원'], version: 1 });
    assert.equal(confirmed.status, 200);
    await ctx.pool.query(
      `UPDATE transport SET departed_at = now() - interval '20 minutes' WHERE id = $1`,
      [s.transportId],
    );

    const record = {
      clientRecordId: randomUUID(),
      kind: 'arrive',
      transportId: s.transportId,
      occurredAt: minutesAgo(3),
      method: 'button',
    };
    const res = await sync(ctx, s.lee, [record]);
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].outcome, 'applied');
    assert.equal(res.body.transport.status, 'arrived');
    const { rows } = await ctx.pool.query(
      `SELECT round(extract(epoch FROM now() - arrived_at) / 60)::int AS ago, arrival_method,
              (SELECT round(extract(epoch FROM now() - hr.arrived_at) / 60)::int FROM hospital_request hr
                WHERE hr.id = $2) AS request_ago
         FROM transport WHERE id = $1`,
      [s.transportId, s.req['B병원']],
    );
    assert.deepEqual(rows[0], { ago: 3, arrival_method: 'button', request_ago: 3 });
    // 다시 올리면 이미 도착
    assert.equal((await sync(ctx, s.lee, [record])).body.results[0].outcome, 'duplicate');
  });
});

test('그사이 서버에 유효한 승인이 생겼으면 오프라인 전화 결과는 이력으로만 남기고 경보 (SFR-099)', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx); // B·C 승인이 아직 유효 (5분 안)
    const h = await hospitalIds(ctx.pool);
    const res = await sync(ctx, s.kim, [
      {
        clientRecordId: randomUUID(),
        kind: 'phone_check',
        transportId: s.transportId,
        occurredAt: minutesAgo(1),
        hospitalId: h['D병원'],
        result: 'accepted',
      },
    ]);
    assert.equal(res.body.results[0].outcome, 'history_only');
    assert.equal(res.body.alert, true);
    assert.equal(res.body.transport.status, 'requesting');
    const { rows } = await ctx.pool.query(
      `SELECT p.result, p.offline, t.confirmed_hospital_id
         FROM phone_check p JOIN transport t ON t.id = p.transport_id WHERE t.id = $1`,
      [s.transportId],
    );
    assert.deepEqual(rows, [{ result: 'accepted', offline: true, confirmed_hospital_id: null }]);
  });
});

test('통신 두절 중 만든 예비 추천 건: 등록되고 병원 요청은 보내지 않는다, 같은 ID 는 한 번만', async () => {
  await withAuthContext(async (ctx) => {
    const kim = await login(ctx, 'kim01');
    await request(appFor(ctx)).post('/api/v1/teams').set(auth(kim)).send({ role: 'driver' });
    const record = {
      clientRecordId: randomUUID(),
      kind: 'create_fallback',
      transportId: randomUUID(),
      occurredAt: minutesAgo(6),
      assessment: { chiefComplaint: '흉통', spo2: 91 },
      radiusKm: 20,
      location: ORIGIN,
    };
    const res = await sync(ctx, kim, [record]);
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].outcome, 'applied');
    assert.equal(res.body.transport.status, 'fallback');
    assert.equal(res.body.transport.offlineCreated, true);
    assert.equal(res.body.transport.fallbackReason, 'offline');
    const { rows } = await ctx.pool.query(
      `SELECT round(extract(epoch FROM now() - created_at) / 60)::int AS ago,
              (SELECT count(*)::int FROM request_round WHERE transport_id = $1) AS rounds,
              (SELECT spo2 FROM assessment WHERE transport_id = $1 AND seq = 1) AS spo2
         FROM transport WHERE id = $1`,
      [record.transportId],
    );
    assert.deepEqual(rows[0], { ago: 6, rounds: 0, spo2: 91 });
    assert.equal((await sync(ctx, kim, [record])).body.results[0].outcome, 'duplicate');
  });
});

test('팀에 다른 진행 중 건이 있으면 서버 건을 남기고 오프라인 건은 offline_superseded 이력으로', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const offlineId = randomUUID();
    const res = await sync(ctx, s.lee, [
      {
        clientRecordId: randomUUID(),
        kind: 'create_fallback',
        transportId: offlineId,
        occurredAt: minutesAgo(2),
        assessment: { chiefComplaint: '복통' },
        radiusKm: 20,
        location: ORIGIN,
      },
    ]);
    assert.equal(res.body.results[0].outcome, 'history_only');
    assert.equal(res.body.alert, true);
    const { rows } = await ctx.pool.query(
      `SELECT id, status, cancel_reason, origin_lat FROM transport ORDER BY created_at`,
    );
    assert.deepEqual(
      rows.map((r) => [r.id === offlineId, r.status, r.cancel_reason, r.origin_lat]),
      [
        [true, 'cancelled', 'offline_superseded', null],
        [false, 'requesting', null, rows[1].origin_lat],
      ],
    );
  });
});

test('남의 팀 건·끝난 건의 전화 결과·잘못된 기록은 그 기록만 거절하고 나머지는 계속', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await toFallback(ctx.pool, s);
    const h = await hospitalIds(ctx.pool);
    const park = await login(ctx, 'park01');
    await request(appFor(ctx)).post('/api/v1/teams').set(auth(park)).send({ role: 'driver' });

    const other = await sync(ctx, park, [
      {
        clientRecordId: randomUUID(),
        kind: 'arrive',
        transportId: s.transportId,
        occurredAt: minutesAgo(1),
        method: 'menu',
      },
    ]);
    assert.deepEqual(
      other.body.results.map((r: { outcome: string; code: string }) => [r.outcome, r.code]),
      [['rejected', 'NOT_FOUND']],
    );
    assert.equal(other.body.transport, null);

    // 1번: 연결 실패인데 사유 없음 → 거절, 2번: 정상 거절 → 반영
    const res = await sync(ctx, s.kim, [
      {
        clientRecordId: randomUUID(),
        kind: 'phone_check',
        transportId: s.transportId,
        occurredAt: minutesAgo(3),
        hospitalId: h['B병원'],
        result: 'no_answer',
      },
      {
        clientRecordId: randomUUID(),
        kind: 'phone_check',
        transportId: s.transportId,
        occurredAt: minutesAgo(2),
        hospitalId: h['B병원'],
        result: 'rejected',
      },
    ]);
    assert.deepEqual(
      res.body.results.map((r: { outcome: string; code: string | null }) => [r.outcome, r.code]),
      [
        ['rejected', 'REASON_REQUIRED'],
        ['applied', null],
      ],
    );

    // 형식이 틀린 기록(종류 없음)은 통째로 400
    const bad = await sync(ctx, s.kim, [
      { clientRecordId: randomUUID(), transportId: s.transportId },
    ]);
    assert.equal(bad.status, 400);
  });
});
