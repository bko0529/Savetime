// 응답 모양은 2026-11-02 충청남도 실제 응답을 따른다. 공공 API는 호출하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { withSchemaPool } from '../../testing/services.js';
import { parseCapabilities, runCapabilityCollect } from './capabilities.js';
import {
  parseDepartments,
  parseHospitals,
  runHospitalCollect,
  EMCLS_TO_GRADE,
} from './hospitals.js';
import { CollectError, type FetchItems } from './publicApi.js';
import type { ApiQuota } from './quota.js';
import { runCollectRound } from './round.js';

const logger = pino({ level: 'silent' });
const quota: ApiQuota = {
  take: async () => {},
  isExhausted: async () => false,
  save: async () => {},
};
const regions = ['충청남도'];

const listItem = {
  hpid: 'A2400002',
  dutyName: '단국대학교의과대학부속병원',
  dutyAddr: '충청남도 천안시 동남구 망향로 201',
  dutyEmcls: 'G001',
  dutyEmclsName: '권역응급의료센터',
  dutyTel1: '041-550-7114',
  dutyTel3: '041-550-7115',
  wgs84Lat: 36.84295215169462,
  wgs84Lon: 127.17327537305154,
};

function fakeApi(handlers: Record<string, () => unknown[] | Error>): FetchItems {
  return async (operation) => {
    const result = handlers[operation]?.() ?? [];
    if (result instanceof Error) throw result;
    return result;
  };
}

test('종별을 부록 F대로 등급으로 바꾼다', () => {
  assert.deepEqual(EMCLS_TO_GRADE, {
    권역응급의료센터: 1,
    지역응급의료센터: 2,
    지역응급의료기관: 3,
  });
  const grades = ['권역응급의료센터', '지역응급의료센터', '지역응급의료기관', '응급실운영신고기관']
    .map((dutyEmclsName) => parseHospitals([{ ...listItem, dutyEmclsName }]).hospitals[0].grade)
    .concat(parseHospitals([{ ...listItem, dutyEmclsName: undefined }]).hospitals[0].grade);
  assert.deepEqual(grades, [1, 2, 3, 3, 3]);
});

test('좌표가 없는 병원은 저장 대상에서 빼고 따로 모은다', () => {
  const { hospitals, noCoords } = parseHospitals([
    listItem,
    { ...listItem, hpid: 'B', wgs84Lat: undefined },
  ]);
  assert.equal(hospitals.length, 1);
  assert.deepEqual(noCoords, ['B']);
});

test('진료과는 쉼표로 나누고 값이 없으면 빈 목록이다', () => {
  assert.deepEqual(parseDepartments('가정의학과, 내과,,외과'), ['가정의학과', '내과', '외과']);
  assert.deepEqual(parseDepartments(undefined), []);
});

test('진료가능 값: Y(공백 포함)·불가능·N만 저장하고 정보미제공은 뺀다', () => {
  const rows = parseCapabilities([
    {
      hpid: 'A',
      MKioskTy1: 'Y         ',
      MKioskTy2: '불가능',
      MKioskTy3: 'N',
      MKioskTy4: '정보미제공',
      MKioskTy28: 'Y         ',
    },
  ]);
  assert.deepEqual(rows, [
    { publicId: 'A', code: 'mkioskty1', available: true },
    { publicId: 'A', code: 'mkioskty2', available: false },
    { publicId: 'A', code: 'mkioskty3', available: false },
  ]);
});

test('병원·등급·진료과를 저장하고, 다시 수집해도 우리가 관리하는 값은 유지한다', async () => {
  await withSchemaPool(async (pool) => {
    const fetchItems = fakeApi({
      getEgytListInfoInqire: () => [
        listItem,
        { ...listItem, hpid: 'NOCOORD', wgs84Lon: undefined },
      ],
      getEgytBassInfoInqire: () => [{ dgidIdName: '내과,외과' }],
    });
    await runHospitalCollect({ pool, fetchItems, quota, regions, logger });

    await pool.query(`UPDATE hospital SET account_active = true, entrance_lat = 36.1`);
    await runHospitalCollect({ pool, fetchItems, quota, regions, logger });

    const { rows } = await pool.query('SELECT * FROM hospital');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].grade, 1);
    assert.equal(rows[0].emcls_code, 'G001');
    assert.equal(rows[0].er_phone, '041-550-7115');
    assert.deepEqual(rows[0].departments, ['내과', '외과']);
    assert.equal(rows[0].account_active, true);
    assert.equal(rows[0].entrance_lat, '36.100000');

    const anomalies = await pool.query('SELECT public_id, reason FROM bed_anomaly_log LIMIT 1');
    assert.deepEqual(anomalies.rows, [{ public_id: 'NOCOORD', reason: 'no_coords' }]);
    const logs = await pool.query(`SELECT kind, success, hospital_count FROM collect_log LIMIT 1`);
    assert.deepEqual(logs.rows, [{ kind: 'hospitals', success: true, hospital_count: 1 }]);
  });
});

test('한 병원의 진료과 조회가 실패해도 다른 병원은 저장하고 이전 값을 유지한다', async () => {
  await withSchemaPool(async (pool) => {
    const list = [listItem, { ...listItem, hpid: 'A2400001' }];
    const ok: FetchItems = async (operation) =>
      operation === 'getEgytListInfoInqire' ? list : [{ dgidIdName: '내과' }];
    await runHospitalCollect({ pool, fetchItems: ok, quota, regions, logger });

    const partlyFailing: FetchItems = async (operation, params) => {
      if (operation === 'getEgytListInfoInqire') return list;
      if (params.HPID === 'A2400002') throw new CollectError('NETWORK');
      return [{ dgidIdName: '외과' }];
    };
    await runHospitalCollect({ pool, fetchItems: partlyFailing, quota, regions, logger });

    const { rows } = await pool.query(
      'SELECT public_id, departments FROM hospital ORDER BY public_id',
    );
    assert.deepEqual(rows, [
      { public_id: 'A2400001', departments: ['외과'] },
      { public_id: 'A2400002', departments: ['내과'] },
    ]);
  });
});

test('호출 한도에 닿으면 남은 병원은 조회하지 않는다', async () => {
  await withSchemaPool(async (pool) => {
    const list = Array.from({ length: 10 }, (_, i) => ({ ...listItem, hpid: `H${i}` }));
    let calls = 0;
    const fetchItems: FetchItems = async (operation) => {
      if (operation === 'getEgytListInfoInqire') return list;
      calls += 1;
      throw new CollectError('QUOTA_EXCEEDED');
    };
    await runHospitalCollect({ pool, fetchItems, quota, regions, logger });
    assert.ok(calls <= 4, `호출 ${calls}번`);
  });
});

test('진료가능 항목은 다시 수집하면 통째로 바뀐다', async () => {
  await withSchemaPool(async (pool) => {
    const fetchHospitals = fakeApi({ getEgytListInfoInqire: () => [listItem] });
    await runHospitalCollect({ pool, fetchItems: fetchHospitals, quota, regions, logger });

    const severe = (value: string) =>
      fakeApi({
        getSrsillDissAceptncPosblInfoInqire: () => [{ hpid: listItem.hpid, MKioskTy1: value }],
      });
    await runCapabilityCollect({ pool, fetchItems: severe('Y  '), quota, regions, logger });
    const first = await pool.query(
      `SELECT i.name, c.available FROM hospital_capability c
         JOIN capability_item i ON i.code = c.item_code`,
    );
    assert.deepEqual(first.rows, [{ name: '[재관류중재술] 심근경색', available: true }]);

    await runCapabilityCollect({ pool, fetchItems: severe('정보미제공'), quota, regions, logger });
    const second = await pool.query('SELECT count(*) FROM hospital_capability');
    assert.equal(second.rows[0].count, '0');
  });
});

test('다른 수집의 성공 기록은 병상 수집 순서에 영향을 주지 않는다', async () => {
  await withSchemaPool(async (pool) => {
    await pool.query(
      `INSERT INTO collect_log (kind, region, success) VALUES ('hospitals', '서울특별시', true)`,
    );
    const order: string[] = [];
    await runCollectRound({
      pool,
      quota,
      logger,
      regions: ['서울특별시', '충청남도'],
      fetchBeds: async (region) => {
        order.push(region);
        return [
          { publicId: 'x', sourceTime: '2026-11-02T14:03:00+09:00', raw: {}, excluded: false },
        ];
      },
    });
    assert.deepEqual(order, ['서울특별시', '충청남도']);
  });
});
