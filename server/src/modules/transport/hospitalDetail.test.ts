// SFR-007 인수 기준을 임시 DB에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { withSchemaPool } from '../../testing/services.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

function appWith(pool?: pg.Pool) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, hospitalDetailPool: pool });
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
  await withSchemaPool(async (pool) => {
    const id = await addHospital(pool);
    await pool.query(
      `INSERT INTO bed_current
         (hospital_id, er_avail, er_total, icu_avail, icu_total, or_avail, or_total, source_time)
       VALUES ($1, 9, 13, 2, 10, 0, 4, '2026-11-02T14:03:00+09:00')`,
      [id],
    );

    const res = await request(appWith(pool)).get(`/api/v1/hospitals/${id}`);

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
  await withSchemaPool(async (pool) => {
    const id = await addHospital(pool);
    await pool.query(
      `INSERT INTO hospital_capability (hospital_id, item_code, available, updated_at)
       VALUES ($1, 'mkioskty10', false, now()), ($1, 'mkioskty2', true, now())`,
      [id],
    );

    const { body } = await request(appWith(pool)).get(`/api/v1/hospitals/${id}`);

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
  await withSchemaPool(async (pool) => {
    const id = await addHospital(pool);
    await pool.query(
      `INSERT INTO bed_current (hospital_id, er_avail, er_total, source_time)
       VALUES ($1, 3, 5, now())`,
      [id],
    );

    const { body } = await request(appWith(pool)).get(`/api/v1/hospitals/${id}`);

    assert.deepEqual(body.beds.er, { avail: 3, total: 5 });
    assert.deepEqual(body.beds.or, { avail: null, total: null });
  });
});

test('병상 데이터가 전혀 없는 병원도 상세를 내려준다', async () => {
  await withSchemaPool(async (pool) => {
    const id = await addHospital(pool);

    const res = await request(appWith(pool)).get(`/api/v1/hospitals/${id}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.beds.er, { avail: null, total: null });
    assert.equal(res.body.bedsSourceTime, null);
    assert.deepEqual(res.body.capabilities, []);
  });
});

test('없는 병원과 잘못된 ID는 404 NOT_FOUND다', async () => {
  await withSchemaPool(async (pool) => {
    const app = appWith(pool);
    for (const id of ['999', 'abc', '0', '-1', '1.5', '99999999999999999999']) {
      const res = await request(app).get(`/api/v1/hospitals/${id}`);
      assert.equal(res.status, 404, id);
      assert.equal(res.body.error.code, 'NOT_FOUND', id);
    }
  });
});

test('DB를 넘겨주지 않으면 API가 켜지지 않는다 (운영 환경)', async () => {
  const res = await request(appWith()).get('/api/v1/hospitals/1');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.message, '요청한 주소를 찾을 수 없어요');
});
