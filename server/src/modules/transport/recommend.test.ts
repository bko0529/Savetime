// 주변 병원·추천 목록 API를 임시 DB로 확인한다 (SFR-001·002·027·087·098).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, withAuthContext } from '../../testing/auth.js';
import { signAccessToken } from '../auth/tokens.js';
import type { EtaLookup } from './eta.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const ORIGIN = { lat: 36.8, lng: 127.1 };
const KM_PER_LAT = 111.195; // 위도 1도의 거리 (지구 반지름 6371km)
let teamCount = 0;

interface Harness {
  pool: pg.Pool;
  paramedicId: string;
  get: (path: string) => request.Test;
}

async function withApi(use: (h: Harness) => Promise<void>, eta?: EtaLookup): Promise<void> {
  await withAuthContext(async (auth) => {
    const app = createApp({ logger, healthChecks: { db: ok, redis: ok }, auth, eta });
    const paramedicId = await addParamedic(auth.pool);
    const token = await signAccessToken(auth.jwtKey, { paramedicId, sessionVersion: 1 });
    await use({
      pool: auth.pool,
      paramedicId,
      get: (path) => request(app).get(path).set('Authorization', `Bearer ${token}`),
    });
  });
}

// 출발지에서 정북으로 km만큼 떨어진 병원
async function addHospital(
  pool: pg.Pool,
  name: string,
  km: number,
  { grade = 3, beds }: { grade?: number; beds?: (number | null)[] | 'anomaly' } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, grade, er_phone)
     VALUES ($1, $1, $2, $3, $4, '041-000') RETURNING id`,
    [name, ORIGIN.lat + km / KM_PER_LAT, ORIGIN.lng, grade],
  );
  const id = rows[0].id;
  if (beds) {
    const values = beds === 'anomaly' ? [9, 3, 1, 2, 1, 2] : beds;
    await pool.query(
      `INSERT INTO bed_current
         (hospital_id, er_avail, er_total, icu_avail, icu_total, or_avail, or_total, source_time, excluded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-11-03T10:00:00+09:00', $8)`,
      [id, ...values, beds === 'anomaly'],
    );
  }
  return id;
}

async function addTransport(
  pool: pg.Pool,
  paramedicId: string,
  {
    requestedGrade = null,
    origin = ORIGIN,
  }: { requestedGrade?: number | null; origin?: typeof ORIGIN | null } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    // 팀 코드는 활동 중인 팀끼리 겹치면 안 된다
    `INSERT INTO team (code, qr_token, created_by) VALUES ($2, 'qr', $1) RETURNING id`,
    [paramedicId, String(1000 + teamCount++)],
  );
  await pool.query(
    `INSERT INTO team_member (team_id, paramedic_id, role) VALUES ($1, $2, 'care')`,
    [rows[0].id, paramedicId],
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO transport (id, team_id, location_consent, origin_lat, origin_lng, requested_grade)
     VALUES ($1, $2, true, $3, $4, $5)`,
    [id, rows[0].id, origin?.lat ?? null, origin?.lng ?? null, requestedGrade],
  );
  return id;
}

const OK_BEDS = [4, 10, 2, 8, 1, 3];

test('주변 병원: 반경 안 전체를 거리순으로 준다 (SFR-001·027)', async () => {
  await withApi(async ({ pool, get }) => {
    await addHospital(pool, '먼병원', 25, { beds: OK_BEDS });
    await addHospital(pool, '가까운병원', 1, { beds: OK_BEDS });
    await addHospital(pool, '중간병원', 15);

    const res = await get(`/api/v1/hospitals/nearby?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((c: { name: string; distanceKm: number; rank: null }) => [
        c.name,
        c.distanceKm,
        c.rank,
      ]),
      [
        ['가까운병원', 1, null],
        ['중간병원', 15, null],
      ],
    );

    const wide = await get(
      `/api/v1/hospitals/nearby?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=30`,
    );
    assert.equal(wide.body.length, 3);
  });
});

test('주변 병원: 대한민국 밖 좌표와 없는 반경은 조회하지 않는다 (SFR-087)', async () => {
  await withApi(async ({ get }) => {
    const outside = await get('/api/v1/hospitals/nearby?lat=0&lng=0');
    assert.equal(outside.status, 400);
    assert.equal(outside.body.error.details.reason, 'coords_out_of_korea');

    const radius = await get(
      `/api/v1/hospitals/nearby?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=15`,
    );
    assert.equal(radius.status, 400);
    assert.deepEqual(radius.body.error.details.fields, ['radiusKm']);

    const missing = await get('/api/v1/hospitals/nearby?lat=abc');
    assert.equal(missing.status, 400);
  });
});

test('추천 목록: 게이트·제외·등급·병상 정보 없음을 반영하고 지도에는 반경 안 전체를 준다', async () => {
  await withApi(async ({ pool, paramedicId, get }) => {
    const transportId = await addTransport(pool, paramedicId, { requestedGrade: 2 });
    await addHospital(pool, '일반가까움', 1, { beds: OK_BEDS, grade: 3 });
    await addHospital(pool, '종합중간', 5, { beds: OK_BEDS, grade: 2 });
    await addHospital(pool, '대학먼곳', 12, { beds: OK_BEDS, grade: 1 });
    await addHospital(pool, '응급실0', 2, { beds: [0, 10, 2, 8, 1, 3] });
    await addHospital(pool, '이상치', 3, { beds: 'anomaly' });
    await addHospital(pool, '정보없음', 4);
    const rejected = await addHospital(pool, '거절한곳', 0.5, { beds: OK_BEDS });
    await pool.query(
      `INSERT INTO excluded_hospital (transport_id, hospital_id, reason) VALUES ($1, $2, 'rejected')`,
      [transportId, rejected],
    );
    await addHospital(pool, '반경밖', 30, { beds: OK_BEDS });

    const res = await get(`/api/v1/transports/${transportId}/recommendations`);
    assert.equal(res.status, 200);
    const names = (list: { name: string }[]) => list.map((c) => c.name);
    assert.equal(res.body.radiusKm, 20);
    assert.deepEqual(names(res.body.items), ['종합중간', '대학먼곳', '일반가까움']);
    assert.deepEqual(names(res.body.noBedInfo), ['정보없음']);
    assert.equal(res.body.emptyGuide, null);
    assert.equal(res.body.map.length, 7);
    const excludedCard = res.body.map.find((c: { name: string }) => c.name === '거절한곳');
    assert.deepEqual([excludedCard.excluded, excludedCard.rank], [true, null]);

    // 카드 요약 (SFR-002)
    const first = res.body.items[0];
    assert.deepEqual(
      {
        rank: first.rank,
        distanceKm: first.distanceKm,
        etaMin: first.etaMin,
        beds: first.beds,
        inRegion: first.inRegion,
        grade: first.grade,
        capabilityCount: first.capabilityCount,
        bedsSourceTime: first.bedsSourceTime,
      },
      {
        rank: 1,
        distanceKm: 5,
        etaMin: null,
        beds: { er: '4/10', icu: '2/8', or: '1/3' },
        inRegion: true,
        grade: 2,
        capabilityCount: { available: 0, total: 0 },
        bedsSourceTime: '2026-11-03T01:00:00.000Z',
      },
    );
  });
});

test('추천 카드: 진료가능 항목 수와 비어 있는 병상을 그대로 보여 준다', async () => {
  await withApi(async ({ pool, paramedicId, get }) => {
    const transportId = await addTransport(pool, paramedicId);
    const id = await addHospital(pool, 'A병원', 1, { beds: [3, null, null, null, null, null] });
    await pool.query(
      `INSERT INTO hospital_capability (hospital_id, item_code, available, updated_at)
       VALUES ($1, 'mkioskty1', true, now()), ($1, 'mkioskty2', true, now()), ($1, 'mkioskty3', false, now())`,
      [id],
    );
    const res = await get(`/api/v1/transports/${transportId}/recommendations`);
    assert.deepEqual(res.body.items[0].beds, { er: '3', icu: null, or: null });
    assert.deepEqual(res.body.items[0].capabilityCount, { available: 2, total: 3 });
  });
});

test('추천 후보가 0곳이면 반경 넓히기를 안내한다 (SFR-029)', async () => {
  await withApi(async ({ pool, paramedicId, get }) => {
    const transportId = await addTransport(pool, paramedicId);
    await addHospital(pool, '응급실0', 2, { beds: [0, 10, 2, 8, 1, 3] });
    const res = await get(`/api/v1/transports/${transportId}/recommendations`);
    assert.deepEqual([res.body.items, res.body.emptyGuide], [[], 'expand_radius']);
  });
});

test('내 팀 이송이 아니거나 잘못된 ID면 404, 출발 위치가 없으면 409다', async () => {
  await withApi(async ({ pool, paramedicId, get }) => {
    const other = await addParamedic(pool, { loginId: 'other01' });
    const othersTransport = await addTransport(pool, other);
    for (const id of [othersTransport, randomUUID(), 'not-a-uuid']) {
      const res = await get(`/api/v1/transports/${id}/recommendations`);
      assert.equal(res.status, 404, id);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }
    await pool.query('DELETE FROM team_member');
    const noOrigin = await addTransport(pool, paramedicId, { origin: null });
    const res = await get(`/api/v1/transports/${noOrigin}/recommendations`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'LOCATION_REQUIRED');
  });
});

test('예상 이동시간을 카드에 채우고, 못 구한 곳은 null이다 (SFR-072·073)', async () => {
  const asked: string[][] = [];
  const eta: EtaLookup = async (_origin, destinations) => {
    asked.push(destinations.map((d) => d.id));
    // 첫 병원만 성공, 나머지는 실패한 것처럼
    return new Map([[destinations[0].id, 7]]);
  };
  await withApi(async ({ pool, paramedicId, get }) => {
    const transportId = await addTransport(pool, paramedicId);
    await addHospital(pool, '가까움', 1, { beds: OK_BEDS });
    await addHospital(pool, '중간', 3, { beds: OK_BEDS });
    await addHospital(pool, '응급실0', 2, { beds: [0, 10, 2, 8, 1, 3] });

    const res = await get(`/api/v1/transports/${transportId}/recommendations`);
    assert.deepEqual(
      res.body.items.map((c: { name: string; etaMin: number | null }) => [c.name, c.etaMin]),
      [
        ['가까움', 7],
        ['중간', null],
      ],
    );
    // 게이트를 통과한 곳만 길찾기 대상이다 (응급실 0개는 묻지 않음)
    assert.equal(asked[0].length, 2);
    const mapCard = res.body.map.find((c: { name: string }) => c.name === '가까움');
    assert.equal(mapCard.etaMin, 7);
  }, eta);
});

test('주변 병원은 오프라인 저장용으로 기준 시각·참고용 여부·진료가능 항목까지 준다 (SFR-059·081)', async () => {
  await withApi(async ({ pool, get }) => {
    const a = await addHospital(pool, 'A병원', 1, { beds: [3, 10, 1, 2, 0, 1] });
    await addHospital(pool, 'B병원', 2); // 병상 데이터 없음
    await pool.query(
      `UPDATE bed_current SET collected_at = now() - interval '12 minutes' WHERE hospital_id = $1`,
      [a],
    );
    await pool.query(
      `INSERT INTO hospital_capability (hospital_id, item_code, available, updated_at)
       VALUES ($1, 'mkioskty1', true, now()), ($1, 'mkioskty2', false, now())`,
      [a],
    );

    const res = await get(`/api/v1/hospitals/nearby?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
    assert.equal(res.status, 200);
    const [cardA, cardB] = res.body;
    assert.equal(cardA.name, 'A병원');
    assert.equal(cardA.stale, true);
    assert.ok(Date.now() - new Date(cardA.collectedAt).getTime() >= 11 * 60_000);
    assert.equal(cardA.erPhone, '041-000');
    assert.equal(cardA.capabilities.length, 2);
    assert.deepEqual(
      cardA.capabilities.map((c: { available: boolean }) => c.available),
      [true, false],
    );
    assert.deepEqual(cardA.capabilityCount, { available: 1, total: 2 });
    assert.deepEqual([cardB.collectedAt, cardB.stale, cardB.capabilities], [null, null, []]);
  });
});

test('추천 카드에도 기준 시각과 참고용 여부가 있다 (방금 수집 = 최신)', async () => {
  await withApi(async ({ pool, paramedicId, get }) => {
    const transportId = await addTransport(pool, paramedicId);
    await addHospital(pool, 'A병원', 1, { beds: [3, 10, 1, 2, 0, 1] });
    const res = await get(`/api/v1/transports/${transportId}/recommendations`);
    const card = res.body.items[0];
    assert.equal(card.stale, false);
    assert.ok(Math.abs(Date.now() - new Date(card.collectedAt).getTime()) < 60_000);
    assert.equal(card.capabilities, undefined);
  });
});
