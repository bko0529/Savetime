// SFR-121 도착 예정 환자 목록 (GET /hw/incoming) 인수 기준을 임시 DB·실제 Redis 로 확인한다.
// 병원 좌표는 (36.8, 127.1). 위도 0.001도 ≈ 111m 라 36.801 은 200m 안, 36.83 은 약 3.3km 밖이다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { addParamedic } from '../../testing/auth.js';
import { addHospitalWithKey } from '../../testing/hospitalWeb.js';
import { withRequestApp, type RequestHarness } from '../../testing/requestApp.js';

let seq = 0;

// 확정된 이송 건 1개. status 로 이동 중·도착·수용 불가를, arrivedAgo 로 도착 뒤 지난 시간을 만든다
async function confirmedTo(
  pool: pg.Pool,
  hospitalId: string,
  opts: {
    status?: 'confirmed' | 'arrived' | 'unacceptable';
    arrivedAgo?: string;
    locationConsent?: boolean;
    etaMin?: number;
    confirmedAgo?: string;
  } = {},
): Promise<{ transportId: string; requestId: number }> {
  const { status = 'confirmed', locationConsent = true } = opts;
  const paramedicId = await addParamedic(pool, { loginId: `p${randomBytes(3).toString('hex')}` });
  const { rows: teams } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ($2, 'qr', $1) RETURNING id`,
    [paramedicId, String(3000 + (seq += 1))],
  );
  await pool.query(
    "INSERT INTO team_member (team_id, paramedic_id, role) VALUES ($1, $2, 'driver')",
    [teams[0].id, paramedicId],
  );
  const transportId = randomUUID();
  const arrived = status !== 'confirmed';
  await pool.query(
    `INSERT INTO transport (id, team_id, status, location_consent, confirmed_hospital_id, departed_at, confirmed_at, arrived_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '20 minutes', now() - $6::interval,
             CASE WHEN $7 THEN now() - $8::interval END)`,
    [
      transportId,
      teams[0].id,
      arrived ? 'arrived' : 'moving',
      locationConsent,
      hospitalId,
      opts.confirmedAgo ?? '0 seconds',
      arrived,
      opts.arrivedAgo ?? '1 minute',
    ],
  );
  const { rows: rounds } = await pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() - interval '30 minutes', now() - interval '28 minutes', now() - interval '25 minutes')
     RETURNING id`,
    [transportId],
  );
  // 요청을 보낼 때의 환자 평가 (받은 뒤 바뀐 항목을 보려고 1행)
  await pool.query(
    `INSERT INTO assessment (transport_id, seq, chief_complaint, sex, age_band, spo2, sent_at)
     VALUES ($1, 1, '뇌출혈 의심', 'M', '60s', 95, now() - interval '31 minutes')`,
    [transportId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_request (round_id, hospital_id, status, eta_min, responded_at, arrived_at)
     VALUES ($1, $2, $3, $4, now() - interval '29 minutes', CASE WHEN $5 THEN now() - $6::interval END)
     RETURNING id`,
    [rounds[0].id, hospitalId, status, opts.etaMin ?? 7, arrived, opts.arrivedAgo ?? '1 minute'],
  );
  return { transportId, requestId: Number(rows[0].id) };
}

async function addPoint(pool: pg.Pool, transportId: string, lat: number) {
  await pool.query(
    `INSERT INTO location_point (transport_id, device_id, lat, lng, recorded_at)
     VALUES ($1, 'nav-1', $2, 127.1, now())`,
    [transportId, lat],
  );
}

const list = async (h: RequestHarness) => {
  const desk = await h.registerPc('접수대');
  const res = await h.get('/hw/incoming', desk);
  assert.equal(res.status, 200);
  return res.body;
};

test("확정된 이송 건이 '남·60대 · 뇌출혈 의심 · 도착 예상 7분 · 이동 중'으로 보이고, 구급차 위치는 없다 (SFR-121 인수 기준)", async () => {
  await withRequestApp(async (h) => {
    const { transportId, requestId } = await confirmedTo(h.pool, h.hospitalId, { etaMin: 7 });
    await addPoint(h.pool, transportId, 36.83);

    const body = await list(h);
    assert.ok(Date.parse(body.serverNow));
    assert.deepEqual(body.items, [
      {
        id: requestId,
        label: `R-${requestId}`,
        summary: '남·60대 · 뇌출혈 의심',
        status: 'confirmed',
        version: 1,
        etaMin: 7,
        hasLocation: true,
        changedFields: [],
        arrivedAt: null,
        canConfirmArrival: false, // 3km 밖
        canMarkUnacceptable: false,
        extraMemoUsed: false,
      },
    ]);
    // 지도·구급차 위치·거리·구급대 소속은 내보내지 않는다 (SFR-121, 절대 규칙 3)
    assert.doesNotMatch(JSON.stringify(body), /lat|lng|36\.8|127\.1|distance|소방서|안전센터/);
  });
});

test('도착 예상 시간: 내비 값이 있으면 그 값에서, 없으면 확정 때 값에서 지난 분을 뺀다', async () => {
  await withRequestApp(async (h) => {
    const a = await confirmedTo(h.pool, h.hospitalId, {
      etaMin: 9,
      confirmedAgo: '2 minutes 5 seconds',
    });
    const b = await confirmedTo(h.pool, h.hospitalId, { etaMin: 30, confirmedAgo: '5 minutes' });
    await h.pool.query(
      "UPDATE transport SET nav_eta_min = 12, nav_eta_at = now() - interval '1 minute 1 second' WHERE id = $1",
      [b.transportId],
    );
    const etas = Object.fromEntries(
      (await list(h)).items.map((i: { id: number; etaMin: number }) => [i.id, i.etaMin]),
    );
    assert.deepEqual(etas, { [a.requestId]: 7, [b.requestId]: 11 });
  });
});

test("입구 200m 안이면 '도착 확인'이 켜지고, 위치 없는 건은 항상 켜진다 (SFR-144)", async () => {
  await withRequestApp(async (h) => {
    const near = await confirmedTo(h.pool, h.hospitalId);
    await addPoint(h.pool, near.transportId, 36.801);
    const noLocation = await confirmedTo(h.pool, h.hospitalId, { locationConsent: false });
    const noPointYet = await confirmedTo(h.pool, h.hospitalId);

    const items = (await list(h)).items as {
      id: number;
      canConfirmArrival: boolean;
      hasLocation: boolean;
    }[];
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.equal(by[near.requestId].canConfirmArrival, true);
    assert.equal(by[noLocation.requestId].canConfirmArrival, true);
    assert.equal(by[noLocation.requestId].hasLocation, false);
    // 위치 동의 건인데 위치가 아직 없으면 판단할 수 없어 꺼 둔다
    assert.equal(by[noPointYet.requestId].canConfirmArrival, false);
  });
});

test("도착한 환자는 1시간까지 보이고 10분 안에만 '수용 불가'를 누를 수 있다. 요약은 1시간까지 (SFR-158, SER-014)", async () => {
  await withRequestApp(async (h) => {
    const fresh = await confirmedTo(h.pool, h.hospitalId, {
      status: 'arrived',
      arrivedAgo: '3 minutes',
    });
    const later = await confirmedTo(h.pool, h.hospitalId, {
      status: 'arrived',
      arrivedAgo: '20 minutes',
    });
    const refused = await confirmedTo(h.pool, h.hospitalId, {
      status: 'unacceptable',
      arrivedAgo: '5 minutes',
    });
    await confirmedTo(h.pool, h.hospitalId, { status: 'arrived', arrivedAgo: '61 minutes' });

    const items = (await list(h)).items as {
      id: number;
      status: string;
      etaMin: number | null;
      arrivedAt: string | null;
      canMarkUnacceptable: boolean;
      canConfirmArrival: boolean;
      summary: string | null;
    }[];
    // 최근 도착부터. 1시간 지난 건은 빠진다
    assert.deepEqual(
      items.map((i) => i.id),
      [fresh.requestId, refused.requestId, later.requestId],
    );
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.equal(by[fresh.requestId].canMarkUnacceptable, true);
    assert.equal(by[later.requestId].canMarkUnacceptable, false);
    assert.equal(by[refused.requestId].canMarkUnacceptable, false);
    assert.equal(by[refused.requestId].status, 'unacceptable');
    for (const i of items) {
      assert.equal(i.etaMin, null);
      assert.equal(i.canConfirmArrival, false);
      assert.ok(i.arrivedAt);
    }
    assert.equal(by[fresh.requestId].summary, '남·60대 · 뇌출혈 의심');
  });
});

test('받은 뒤 바뀐 항목·추가 메모 사용 여부를 보여 주고, 다른 병원 환자는 보이지 않는다 (SFR-105·140)', async () => {
  await withRequestApp(async (h) => {
    const mine = await confirmedTo(h.pool, h.hospitalId);
    // 이동 중 '변경 사항 보내기'로 산소포화도가 바뀌었다
    await h.pool.query(
      `INSERT INTO assessment (transport_id, seq, chief_complaint, sex, age_band, spo2, sent_at)
       VALUES ($1, 2, '뇌출혈 의심', 'M', '60s', 88, now())`,
      [mine.transportId],
    );
    await h.pool.query(
      "UPDATE hospital_request SET extra_memo = '보호자 동행', extra_memo_at = now() WHERE id = $1",
      [mine.requestId],
    );
    const other = await addHospitalWithKey(h.pool, { publicId: 'H2', name: 'B병원' });
    await confirmedTo(h.pool, other.hospitalId);

    const items = (await list(h)).items;
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].changedFields, ['spo2']);
    assert.equal(items[0].extraMemoUsed, true);
    // 메모 글은 목록에 없다 (상세에서 본다)
    assert.doesNotMatch(JSON.stringify(items), /보호자/);
  });
});
