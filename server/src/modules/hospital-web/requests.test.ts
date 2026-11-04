// SFR-135·155, SER-014 인수 기준(요청 목록: 우리 병원 것만, 마감 빠른 순, 끝난 건은 결과만)을 임시 DB 에서 확인한다.
// 새 요청 알림과 5초 '받았음' 판정은 실시간 서버(#28) 테스트에 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHospitalWithKey } from '../../testing/hospitalWeb.js';
import { addHospitalRequest } from '../../testing/hospitalRequests.js';
import { withRequestApp } from '../../testing/requestApp.js';

test('요청 목록: 우리 병원의 대기·승인만, 마감 빠른 순, 소속 정보 없이', async () => {
  await withRequestApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const { hospitalId: otherHospital } = await addHospitalWithKey(h.pool, {
      publicId: 'H2',
      name: 'B병원',
    });
    const later = await addHospitalRequest(h.pool, h.hospitalId, { respondIn: '100 seconds' });
    const sooner = await addHospitalRequest(h.pool, h.hospitalId, {
      respondIn: '30 seconds',
      chiefComplaint: '호흡곤란',
    });
    const approved = await addHospitalRequest(h.pool, h.hospitalId, {
      status: 'approved',
      respondIn: '60 seconds',
    });
    // 안 나와야 하는 것들: 다른 병원, 마감 지난 대기, 전달 실패, 닫힘
    await addHospitalRequest(h.pool, otherHospital);
    await addHospitalRequest(h.pool, h.hospitalId, { respondIn: '-1 second' });
    await addHospitalRequest(h.pool, h.hospitalId, { status: 'delivery_failed' });
    await addHospitalRequest(h.pool, h.hospitalId, {
      status: 'closed',
      closedReason: 'other_hospital',
    });

    const res = await h.get('/hw/requests?status=open', cookie);

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((i: { id: number }) => i.id),
      [sooner, approved, later],
    );
    assert.deepEqual(res.body.items[0], {
      id: sooner,
      label: `R-${sooner}`,
      status: 'waiting',
      closeReason: null,
      chiefComplaint: '호흡곤란',
      etaMin: 9,
      etaSource: 'straight',
      respondUntil: res.body.items[0].respondUntil,
      abnormalCount: 0,
      prevApprovedRecheck: false,
      respondedBy: null,
      updatedFields: [],
      version: 1,
    });
    assert.equal(res.body.nextCursor, null);
    assert.ok(Date.parse(res.body.serverNow));
    // 구급대 소속(소방서·안전센터·팀)은 어디에도 없다 (절대 규칙 3)
    assert.doesNotMatch(JSON.stringify(res.body), /agency|safety|team|paramedic/i);
  });
});

test('요청 목록 all: 오늘 닫힌 건은 결과만 주고 환자 정보는 null (SER-014)', async () => {
  await withRequestApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const closed = await addHospitalRequest(h.pool, h.hospitalId, {
      status: 'closed',
      closedReason: 'other_hospital',
    });

    const open = await h.get('/hw/requests', cookie);
    assert.deepEqual(open.body.items, []);

    const all = await h.get('/hw/requests?status=all', cookie);
    assert.equal(all.body.items.length, 1);
    assert.equal(all.body.items[0].id, closed);
    assert.equal(all.body.items[0].closeReason, 'other_hospital');
    assert.equal(all.body.items[0].chiefComplaint, null);
  });
});

test('요청 목록: limit 으로 나눠 받고 nextCursor 로 이어 받는다', async () => {
  await withRequestApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const ids = [];
    for (const respondIn of ['20 seconds', '40 seconds', '60 seconds']) {
      ids.push(await addHospitalRequest(h.pool, h.hospitalId, { respondIn }));
    }
    const first = await h.get('/hw/requests?limit=2', cookie);
    assert.deepEqual(
      first.body.items.map((i: { id: number }) => i.id),
      ids.slice(0, 2),
    );
    const second = await h.get(`/hw/requests?limit=2&cursor=${first.body.nextCursor}`, cookie);
    assert.deepEqual(
      second.body.items.map((i: { id: number }) => i.id),
      ids.slice(2),
    );
    assert.equal(second.body.nextCursor, null);

    const bad = await h.get('/hw/requests?status=closed&limit=0', cookie);
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error.details.fields.sort(), ['limit', 'status']);
  });
});

test('요청 목록은 등록 PC 만 본다', async () => {
  await withRequestApp(async (h) => {
    const res = await h.get('/hw/requests', 'st_pc=made-up');
    assert.equal(res.body.error.code, 'PC_NOT_REGISTERED');
  });
});
