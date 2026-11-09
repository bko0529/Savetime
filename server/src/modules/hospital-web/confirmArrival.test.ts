// SFR-144(병원 웹 도착 확인) 인수 기준을 임시 DB·실제 Redis 로 확인한다. 실시간 이벤트는 event_log 기록으로 본다.
// 병원 좌표는 (36.8, 127.1). 위도 0.001도 ≈ 111m 라 36.801 은 200m 안, 36.83 은 약 3.3km 밖이다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { addParamedic } from '../../testing/auth.js';
import { withRequestApp, type RequestHarness } from '../../testing/requestApp.js';

const NEAR = { lat: 36.801, lng: 127.1 };
const FAR = { lat: 36.83, lng: 127.1 };

let seq = 0;

// 우리 병원으로 확정되어 '이동 중'인 이송 건 1개 (대원 1명 팀)
async function movingTo(
  pool: pg.Pool,
  hospitalId: string,
  { locationConsent = true } = {},
): Promise<{ transportId: string; teamId: string; requestId: number }> {
  const paramedicId = await addParamedic(pool, { loginId: `p${randomBytes(3).toString('hex')}` });
  const { rows: teams } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ($2, 'qr', $1) RETURNING id`,
    [paramedicId, String(2000 + (seq += 1))],
  );
  const teamId = teams[0].id;
  await pool.query(
    "INSERT INTO team_member (team_id, paramedic_id, role) VALUES ($1, $2, 'driver')",
    [teamId, paramedicId],
  );
  const transportId = randomUUID();
  await pool.query(
    `INSERT INTO transport (id, team_id, status, location_consent, confirmed_hospital_id, departed_at)
     VALUES ($1, $2, 'moving', $3, $4, now() - interval '10 minutes')`,
    [transportId, teamId, locationConsent, hospitalId],
  );
  const { rows: rounds } = await pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() - interval '5 minutes', now() - interval '2 minutes') RETURNING id`,
    [transportId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_request (round_id, hospital_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
    [rounds[0].id, hospitalId],
  );
  return { transportId, teamId, requestId: Number(rows[0].id) };
}

// 담당 단말이 보낸 위치 (오래된 것부터). 마지막 점이 판단 기준이다
async function addPoints(
  pool: pg.Pool,
  transportId: string,
  points: { lat: number; lng: number }[],
) {
  for (const [i, p] of points.entries()) {
    await pool.query(
      `INSERT INTO location_point (transport_id, device_id, lat, lng, recorded_at)
       VALUES ($1, 'nav-1', $2, $3, now() - make_interval(secs => $4))`,
      [transportId, p.lat, p.lng, (points.length - i) * 5],
    );
  }
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

const states = async (pool: pg.Pool, transportId: string, requestId: number) =>
  (
    await pool.query(
      `SELECT t.status AS transport, t.arrival_method, hr.status AS request, hr.version
         FROM transport t, hospital_request hr WHERE t.id = $1 AND hr.id = $2`,
      [transportId, requestId],
    )
  ).rows[0];

test("구급차가 입구 200m 안이면 '도착 확인'으로 이송이 '도착'으로 끝나고 대원 앱에 알린다 (SFR-144 인수 기준)", async () => {
  await withRequestApp(async (h) => {
    const desk = await deskOnShift(h);
    const { transportId, teamId, requestId } = await movingTo(h.pool, h.hospitalId);
    await addPoints(h.pool, transportId, [FAR, NEAR]);

    const res = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, { version: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { result: 'arrived' });

    assert.deepEqual(await states(h.pool, transportId, requestId), {
      transport: 'arrived',
      arrival_method: 'hospital',
      request: 'arrived',
      version: 2,
    });
    // 대원 앱 도착과 같은 처리: 위치 원본은 지우고 익명 경로로 옮긴다 (SFR-039·041)
    const { rows: left } = await h.pool.query(
      'SELECT count(*)::int AS n FROM location_point WHERE transport_id = $1',
      [transportId],
    );
    assert.equal(left[0].n, 0);
    const { rows: routes } = await h.pool.query('SELECT count(*)::int AS n FROM anonymous_route');
    assert.equal(routes[0].n, 1);

    // 대원 앱: '병원에서 도착을 확인했어요'는 method=hospital 인 transport.arrived 로 안다
    const events = await eventsOf(h.pool);
    const arrived = events.find((e) => e.name === 'transport.arrived')!;
    assert.equal(arrived.room, `team:${teamId}`);
    assert.equal(arrived.payload.method, 'hospital');
    assert.ok(
      events.some((e) => e.name === 'incoming.arrived' && e.room === `hospital:${h.hospitalId}`),
    );
    // 이벤트에도 좌표는 없다
    assert.doesNotMatch(JSON.stringify(events), /36\.8|127\.1|lat|lng/);
  });
});

test("구급차가 아직 3km 밖이면 '도착 확인'이 막히고, 병원 웹에는 위치·거리를 알려 주지 않는다 (SFR-144 인수 기준)", async () => {
  await withRequestApp(async (h) => {
    const desk = await deskOnShift(h);
    const { transportId, requestId } = await movingTo(h.pool, h.hospitalId);

    // 위치 기록이 아직 없어도 판단할 수 없으니 막는다
    const none = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, { version: 1 });
    assert.equal(none.status, 409);
    assert.equal(none.body.error.code, 'AMBULANCE_NOT_NEAR');

    await addPoints(h.pool, transportId, [NEAR, FAR]);
    const far = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, { version: 1 });
    assert.equal(far.status, 409);
    assert.equal(far.body.error.code, 'AMBULANCE_NOT_NEAR');
    assert.doesNotMatch(JSON.stringify(far.body), /36\.|127\.|\d+\s?m\b|km/);

    assert.deepEqual(await states(h.pool, transportId, requestId), {
      transport: 'moving',
      arrival_method: null,
      request: 'confirmed',
      version: 1,
    });
    assert.deepEqual(await eventsOf(h.pool), []);
  });
});

test('응급실 입구 좌표가 있으면 병원 좌표 대신 입구에서 200m 를 잰다', async () => {
  await withRequestApp(async (h) => {
    // 입구는 병원 좌표에서 북쪽으로 약 1.1km
    await h.pool.query(
      'UPDATE hospital SET entrance_lat = 36.81, entrance_lng = 127.1 WHERE id = $1',
      [h.hospitalId],
    );
    const desk = await deskOnShift(h);
    const { transportId, requestId } = await movingTo(h.pool, h.hospitalId);

    await addPoints(h.pool, transportId, [NEAR]);
    const atBuilding = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, {
      version: 1,
    });
    assert.equal(atBuilding.body.error.code, 'AMBULANCE_NOT_NEAR');

    await addPoints(h.pool, transportId, [{ lat: 36.8105, lng: 127.1 }]);
    const atEntrance = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, {
      version: 1,
    });
    assert.deepEqual(atEntrance.body, { result: 'arrived' });
  });
});

test("위치 정보가 없는 이송 건은 상태를 바꾸지 않고 대원 앱에 '도착 처리할까요?'를 요청한다 (SFR-144)", async () => {
  await withRequestApp(async (h) => {
    const desk = await deskOnShift(h);
    const { transportId, teamId, requestId } = await movingTo(h.pool, h.hospitalId, {
      locationConsent: false,
    });

    const res = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, { version: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { result: 'asked_paramedic' });
    assert.deepEqual(await states(h.pool, transportId, requestId), {
      transport: 'moving',
      arrival_method: null,
      request: 'confirmed',
      version: 1,
    });
    assert.deepEqual(await eventsOf(h.pool), [
      {
        room: `team:${teamId}`,
        name: 'transport.arrive_requested',
        payload: { transportId, hospitalName: 'A병원' },
      },
    ]);
  });
});

test("대원이 이미 도착 처리했으면 '도착 확인'은 막힌다. version·근무·다른 병원도 확인한다", async () => {
  await withRequestApp(async (h) => {
    const desk = await deskOnShift(h);
    const { transportId, requestId } = await movingTo(h.pool, h.hospitalId);
    await addPoints(h.pool, transportId, [NEAR]);

    const noVersion = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, {});
    assert.equal(noVersion.status, 400);
    assert.equal(noVersion.body.error.code, 'VERSION_REQUIRED');
    const stale = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, { version: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

    // 근무를 시작하지 않은 PC 는 누를 수 없다
    const idle = await h.registerPc('야간 PC');
    const noShift = await h.post(`/hw/requests/${requestId}/confirm-arrival`, idle, { version: 1 });
    assert.equal(noShift.body.error.code, 'SHIFT_REQUIRED');

    // 다른 병원 요청은 있는지조차 알려 주지 않는다
    const { rows: other } = await h.pool.query<{ id: string }>(
      "INSERT INTO hospital (public_id, name, lat, lng) VALUES ('H9', 'B병원', 36.8, 127.1) RETURNING id",
    );
    const theirs = await movingTo(h.pool, other[0].id);
    const notMine = await h.post(`/hw/requests/${theirs.requestId}/confirm-arrival`, desk, {
      version: 1,
    });
    assert.equal(notMine.status, 404);

    // 대원이 먼저 도착을 누른 상태 (병원 요청도 연쇄로 '도착')
    await h.pool.query("UPDATE transport SET status = 'arrived' WHERE id = $1", [transportId]);
    await h.pool.query(
      "UPDATE hospital_request SET status = 'arrived', version = version + 1 WHERE id = $1",
      [requestId],
    );
    const done = await h.post(`/hw/requests/${requestId}/confirm-arrival`, desk, { version: 2 });
    assert.equal(done.status, 409);
    assert.equal(done.body.error.code, 'INVALID_TRANSITION');
    assert.deepEqual(await eventsOf(h.pool), []);
  });
});
