// SFR-007 인수 기준을 임시 DB에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import type { ParamedicStatus } from '../../modules/auth/session.js';
import { signAccessToken } from '../../modules/auth/tokens.js';
import { addParamedic, withAuthContext } from '../../testing/auth.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

interface Harness {
  pool: pg.Pool;
  get: (path: string) => request.Test;
}

// 로그인한 대원으로 요청을 보낸다. 로그인 자체는 auth 테스트에서 따로 확인한다.
async function withApp(
  use: (h: Harness) => Promise<void>,
  status: ParamedicStatus = 'approved',
): Promise<void> {
  await withAuthContext(async (auth) => {
    const app = createApp({ logger, healthChecks: { db: ok, redis: ok }, auth });
    const paramedicId = await addParamedic(auth.pool, { status });
    const token = await signAccessToken(auth.jwtKey, { paramedicId, sessionVersion: 1 });
    await use({
      pool: auth.pool,
      get: (path) => request(app).get(path).set('Authorization', `Bearer ${token}`),
    });
  });
}

async function addHospital(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, address, er_phone, main_phone, grade, departments)
     VALUES ('A1', 'A병원', 36.842952, 127.173275, '충청남도 천안시', '041-1', '041-2', 1,
             ARRAY['내과', '외과'])
     RETURNING id`,
  );
  return rows[0].id;
}

test('병상을 응급실 9/13, 중환자실 2/10, 수술실 0/4로 나누어 내려준다', async () => {
  await withApp(async ({ pool, get }) => {
    const id = await addHospital(pool);
    await pool.query(
      `INSERT INTO bed_current
         (hospital_id, er_avail, er_total, icu_avail, icu_total, or_avail, or_total, source_time)
       VALUES ($1, 9, 13, 2, 10, 0, 4, '2026-11-02T14:03:00+09:00')`,
      [id],
    );

    const res = await get(`/api/v1/hospitals/${id}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.beds, {
      er: { avail: 9, total: 13 },
      icu: { avail: 2, total: 10 },
      or: { avail: 0, total: 4 },
    });
    assert.equal(res.body.bedsSourceTime, '2026-11-02T05:03:00.000Z');
    assert.ok(res.headers['x-server-now']);
  });
});

test('기본 정보와 진료가능 항목을 공공 데이터 표기 그대로 내려준다', async () => {
  await withApp(async ({ pool, get }) => {
    const id = await addHospital(pool);
    await pool.query(
      `INSERT INTO hospital_capability (hospital_id, item_code, available, updated_at)
       VALUES ($1, 'mkioskty10', false, now()), ($1, 'mkioskty2', true, now())`,
      [id],
    );

    const { body } = await get(`/api/v1/hospitals/${id}`);

    assert.deepEqual(
      {
        id: body.id,
        name: body.name,
        lat: body.lat,
        lng: body.lng,
        address: body.address,
        departments: body.departments,
        erPhone: body.erPhone,
        mainPhone: body.mainPhone,
        grade: body.grade,
      },
      {
        id: Number(id),
        name: 'A병원',
        lat: 36.842952,
        lng: 127.173275,
        address: '충청남도 천안시',
        departments: ['내과', '외과'],
        erPhone: '041-1',
        mainPhone: '041-2',
        grade: 1,
      },
    );
    assert.deepEqual(body.capabilities, [
      { name: '[재관류중재술] 뇌경색', available: true },
      { name: '[장중첩/폐색] 영유아', available: false },
    ]);
  });
});

test('비어 있는 병상 항목은 null로 내려준다 (SFR-089)', async () => {
  await withApp(async ({ pool, get }) => {
    const id = await addHospital(pool);
    await pool.query(
      `INSERT INTO bed_current (hospital_id, er_avail, er_total, source_time)
       VALUES ($1, 3, 5, now())`,
      [id],
    );

    const { body } = await get(`/api/v1/hospitals/${id}`);

    assert.deepEqual(body.beds.er, { avail: 3, total: 5 });
    assert.deepEqual(body.beds.or, { avail: null, total: null });
  });
});

test('병상 데이터가 전혀 없는 병원도 상세를 내려준다', async () => {
  await withApp(async ({ pool, get }) => {
    const id = await addHospital(pool);

    const res = await get(`/api/v1/hospitals/${id}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.beds.er, { avail: null, total: null });
    assert.equal(res.body.bedsSourceTime, null);
    assert.equal(res.body.collectedAt, null);
    assert.equal(res.body.stale, null);
    assert.deepEqual(res.body.capabilities, []);
  });
});

test('기준 시각은 서버 수집 시각이고, 10분이 지나면 참고용(stale)이다 (SFR-081, C-12)', async () => {
  await withApp(async ({ pool, get }) => {
    const id = await addHospital(pool);
    // 공공 데이터 시각은 오래됐어도 서버가 방금 수집했으면 최신이다
    await pool.query(
      `INSERT INTO bed_current (hospital_id, er_avail, er_total, source_time, collected_at)
       VALUES ($1, 3, 5, now() - interval '40 minutes', now() - interval '9 minutes')`,
      [id],
    );
    const fresh = await get(`/api/v1/hospitals/${id}`);
    const { rows } = await pool.query<{ collected_at: Date }>(
      'SELECT collected_at FROM bed_current WHERE hospital_id = $1',
      [id],
    );
    assert.equal(fresh.body.collectedAt, rows[0].collected_at.toISOString());
    assert.equal(fresh.body.stale, false);

    // 수집이 실패해 11분 동안 갱신되지 않음 → 참고용 정보
    await pool.query(
      `UPDATE bed_current SET collected_at = now() - interval '11 minutes' WHERE hospital_id = $1`,
      [id],
    );
    const old = await get(`/api/v1/hospitals/${id}`);
    assert.equal(old.body.stale, true);
  });
});

test('없는 병원과 잘못된 ID는 404 NOT_FOUND다', async () => {
  await withApp(async ({ get }) => {
    for (const id of ['999', 'abc', '0', '-1', '1.5', '99999999999999999999']) {
      const res = await get(`/api/v1/hospitals/${id}`);
      assert.equal(res.status, 404, id);
      assert.equal(res.body.error.code, 'NOT_FOUND', id);
    }
  });
});

test('로그인하지 않으면 401, 승인 전 계정은 403 NOT_APPROVED다 (SER-016)', async () => {
  await withApp(async ({ pool, get }) => {
    const id = await addHospital(pool);
    const res = await get(`/api/v1/hospitals/${id}`).set('Authorization', '');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'TOKEN_REVOKED');
  });
  await withApp(async ({ pool, get }) => {
    const id = await addHospital(pool);
    const res = await get(`/api/v1/hospitals/${id}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'NOT_APPROVED');
  }, 'pending');
});

test('인증 설정이 없으면 API가 켜지지 않는다 (관리자 서버)', async () => {
  const app = createApp({ logger, healthChecks: { db: ok, redis: ok } });
  const res = await request(app).get('/api/v1/hospitals/1');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.message, '요청한 주소를 찾을 수 없어요');
});
