// SFR-118·137·155, SER-014 인수 기준(요청 상세, 이상 수치, 열람 기록, 닫힌 요청 숨김)을 임시 DB 에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHospitalWithKey } from '../../testing/hospitalWeb.js';
import { addHospitalRequest } from '../../testing/hospitalRequests.js';
import { withRequestApp, type RequestHarness as Harness } from '../../testing/requestApp.js';

// 등록 + 근무 시작까지 한 PC
async function onShift(h: Harness, staffName = '박서연'): Promise<string> {
  const cookie = await h.registerPc('접수대');
  assert.equal((await h.post('/hw/shifts', cookie, { staffName })).status, 201);
  return cookie;
}

async function viewLogs(h: Harness) {
  const { rows } = await h.pool.query(
    `SELECT hospital_request_id::int AS request_id, staff_name, pc_id::int AS pc_id
       FROM request_view_log ORDER BY id`,
  );
  return rows;
}

test('요청 상세: 환자 평가·이상 수치·도착 예상·우리 병원 병상, 구급대 소속 없음 (SFR-118)', async () => {
  await withRequestApp(async (h) => {
    const cookie = await onShift(h);
    await h.pool.query(
      `INSERT INTO bed_current (hospital_id, er_avail, er_total, icu_avail, icu_total, or_avail, or_total, source_time)
       VALUES ($1, 5, 20, 0, 10, 1, 4, now())`,
      [h.hospitalId],
    );
    const id = await addHospitalRequest(h.pool, h.hospitalId, {
      chiefComplaint: '갑작스러운 두통',
      assessment: { sex: 'M', age_band: '60s', spo2: 86, pulse: 88, bp: '150/90', temp: '36.8' },
    });

    const res = await h.get(`/hw/requests/${id}`, cookie);

    assert.equal(res.status, 200);
    const body = res.body;
    assert.equal(body.label, `R-${id}`);
    assert.equal(body.status, 'waiting');
    assert.equal(body.version, 1);
    assert.equal(body.assessment.chiefComplaint, '갑작스러운 두통');
    assert.equal(body.assessment.spo2, 86);
    assert.equal(body.assessment.temp, 36.8);
    // 산소포화도 86%만 강조, 맥박 88은 기본 (인수 기준)
    assert.deepEqual(body.abnormalFields, ['spo2']);
    assert.equal(body.etaMin, 9);
    assert.deepEqual(body.ourHospital, {
      capability: null,
      beds: { er: '5/20', icu: '0/10', or: '1/4' },
    });
    assert.equal(body.validApprovals, 0);
    assert.ok(Date.parse(body.serverNow));
    // 구급대 소속·연락처는 어디에도 없다 (절대 규칙 3, D-98)
    assert.doesNotMatch(JSON.stringify(body), /agency|safety|team|paramedic|phone/i);
  });
});

test('상세를 열 때마다 병원 PC·담당자 이름이 열람 기록에 남고, 고치거나 지울 수 없다 (SFR-137)', async () => {
  await withRequestApp(async (h) => {
    const cookie = await onShift(h, '박서연');
    const id = await addHospitalRequest(h.pool, h.hospitalId);

    await h.get(`/hw/requests/${id}`, cookie);
    await h.get(`/hw/requests/${id}`, cookie);

    const logs = await viewLogs(h);
    assert.deepEqual(logs, [
      { request_id: id, staff_name: '박서연', pc_id: 1 },
      { request_id: id, staff_name: '박서연', pc_id: 1 },
    ]);
    await h.pool.query("UPDATE request_view_log SET staff_name = '누군가'");
    await h.pool.query('DELETE FROM request_view_log');
    assert.deepEqual(await viewLogs(h), logs);
  });
});

test('근무를 시작하지 않은 PC 는 상세를 못 연다 (누가 봤는지 남겨야 해서)', async () => {
  await withRequestApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const id = await addHospitalRequest(h.pool, h.hospitalId);
    const res = await h.get(`/hw/requests/${id}`, cookie);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SHIFT_REQUIRED');
    assert.deepEqual(await viewLogs(h), []);
  });
});

test('다른 병원 요청·없는 요청은 404 로 숨긴다', async () => {
  await withRequestApp(async (h) => {
    const cookie = await onShift(h);
    const { hospitalId: other } = await addHospitalWithKey(h.pool, {
      publicId: 'H2',
      name: 'B병원',
    });
    const theirs = await addHospitalRequest(h.pool, other);
    for (const path of [`/hw/requests/${theirs}`, '/hw/requests/99999']) {
      const res = await h.get(path, cookie);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }
    assert.equal((await h.get('/hw/requests/abc', cookie)).status, 400);
    assert.deepEqual(await viewLogs(h), []);
  });
});

test('닫힘·만료·거절, 도착 1시간 지난 요청은 환자 정보 없이 REQUEST_CLOSED (SER-014)', async () => {
  await withRequestApp(async (h) => {
    const cookie = await onShift(h);
    const cases: [Parameters<typeof addHospitalRequest>[2], string][] = [
      [{ status: 'closed', closedReason: 'other_hospital' }, 'closed'],
      [{ status: 'expired' }, 'expired'],
      [{ status: 'rejected' }, 'rejected'],
      [{ status: 'arrived', arrivedAgo: '61 minutes' }, 'arrived'],
    ];
    for (const [options, status] of cases) {
      const id = await addHospitalRequest(h.pool, h.hospitalId, options);
      const res = await h.get(`/hw/requests/${id}`, cookie);
      assert.equal(res.status, 409, status);
      assert.equal(res.body.error.code, 'REQUEST_CLOSED');
      assert.deepEqual(res.body.error.details, { status });
      assert.doesNotMatch(JSON.stringify(res.body), /흉통/);
    }
    // 도착 후 1시간 안이면 아직 볼 수 있다
    const recent = await addHospitalRequest(h.pool, h.hospitalId, {
      status: 'arrived',
      arrivedAgo: '59 minutes',
    });
    assert.equal((await h.get(`/hw/requests/${recent}`, cookie)).status, 200);
    assert.equal((await viewLogs(h)).length, 1);
  });
});

test('요청 목록에도 이상 수치 개수가 나온다 (SFR-155)', async () => {
  await withRequestApp(async (h) => {
    const cookie = await onShift(h);
    const id = await addHospitalRequest(h.pool, h.hospitalId, {
      assessment: { bp: '80/50', spo2: 85, pulse: 88 },
    });
    const res = await h.get('/hw/requests', cookie);
    assert.equal(res.body.items[0].id, id);
    assert.equal(res.body.items[0].abnormalCount, 2);
  });
});
