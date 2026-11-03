// SFR-135·161, SER-014 인수 기준(요청 목록, 새 요청 알림과 5초 '받았음' 판정)을
// 임시 DB·실제 Redis·실제 웹소켓 연결로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import { addHospitalWithKey } from '../../testing/hospitalWeb.js';
import { addHospitalRequest } from '../../testing/hospitalRequests.js';
import {
  alarmMembers,
  connected,
  nextEvent,
  resume,
  withLiveHospitalWeb,
  type AlarmOff,
  type Harness,
} from '../../testing/hospitalLive.js';
import { deliverNewRequests, NEW_REQUEST_LABEL } from './delivery.js';

// 근무 시작 + 알림 켜기까지 한 탭. answer=false 면 request.new 에 답하지 않는 '잠든 탭'
async function alarmOnTab(h: Harness, cookie: string, { answer = true } = {}) {
  const tab = h.openTab(cookie);
  if (answer) {
    tab.on('request.new', (_e: unknown, ack: (r: { received: true }) => void) =>
      ack({ received: true }),
    );
  }
  const { shiftId } = (await h.post('/hw/shifts', cookie, { staffName: '박서연' })).body;
  const on = await h.post('/hw/shifts/current/alarm-on', cookie, {
    socketId: await connected(tab),
  });
  assert.equal(on.status, 200);
  return { tab, shiftId: shiftId as number };
}

const deliver = (h: Harness, ids: number[]) =>
  deliverNewRequests({ pool: h.pool, hospitalIo: h.ctx.hospitalIo, ackTimeoutMs: 300 }, ids);

async function hreq(h: Harness, id: number) {
  const { rows } = await h.pool.query(
    'SELECT status, version, delivered_at FROM hospital_request WHERE id = $1',
    [id],
  );
  return rows[0];
}

test('요청 목록: 우리 병원의 대기·승인만, 마감 빠른 순, 소속 정보 없이', async () => {
  await withLiveHospitalWeb(async (h) => {
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
      abnormalCount: null,
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
  await withLiveHospitalWeb(async (h) => {
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
  await withLiveHospitalWeb(async (h) => {
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
  await withLiveHospitalWeb(async (h) => {
    const res = await h.get('/hw/requests', 'st_pc=made-up');
    assert.equal(res.body.error.code, 'PC_NOT_REGISTERED');
  });
});

test('새 요청: 알림 켠 탭만 받고, 한 곳이라도 답하면 전달. 답 없는 탭은 알림이 꺼진다', async () => {
  await withLiveHospitalWeb(async (h) => {
    const awakePc = await h.registerPc('접수대');
    const sleepyPc = await h.registerPc('처치실');
    const offPc = await h.registerPc('원무과');
    const awake = await alarmOnTab(h, awakePc);
    const sleepy = await alarmOnTab(h, sleepyPc, { answer: false });
    // 알림을 안 켠 탭은 request.new 를 받지 않는다
    const off = h.openTab(offPc);
    await connected(off);
    let offGotIt = false;
    off.on('request.new', () => (offGotIt = true));

    const id = await addHospitalRequest(h.pool, h.hospitalId);
    const received = nextEvent<{ room: string; data: object }>(awake.tab, 'request.new');
    const alarmOff = nextEvent<AlarmOff>(sleepy.tab, 'hospital.alarm_off');

    const result = await deliver(h, [id]);

    assert.deepEqual(result, { delivered: [id], failed: [] });
    const event = await received;
    // 이벤트에는 ID·고정 문구·마감 시각만 (절대 규칙 5)
    assert.deepEqual(Object.keys(event.data).sort(), ['label', 'requestId', 'respondUntil']);
    assert.deepEqual(
      { ...event.data, respondUntil: undefined },
      {
        requestId: id,
        label: NEW_REQUEST_LABEL,
        respondUntil: undefined,
      },
    );
    assert.equal((await alarmOff).data.reason, 'no_ack');
    assert.equal(offGotIt, false);

    const row = await hreq(h, id);
    assert.equal(row.status, 'waiting');
    assert.ok(row.delivered_at);
    // 잠든 탭은 요청 대상에서 빠지고, 다시 붙어도 저절로 켜지지 않는다
    assert.deepEqual(await alarmMembers(h), [awake.tab.id]);
    assert.deepEqual(await resume(sleepy.tab, sleepy.shiftId), { ok: false });
    const session = await h.session(sleepyPc);
    assert.equal(session.body.shift.alarmOn, false);
    assert.equal((await h.session(awakePc)).body.shift.alarmOn, true);
  });
});

test('새 요청: 알림 켠 탭이 없거나 아무도 답하지 않으면 delivery_failed', async () => {
  await withLiveHospitalWeb(async (h) => {
    const nobody = await addHospitalRequest(h.pool, h.hospitalId);
    assert.deepEqual(await deliver(h, [nobody]), { delivered: [], failed: [nobody] });
    assert.deepEqual(await hreq(h, nobody), {
      status: 'delivery_failed',
      version: 2,
      delivered_at: null,
    });

    const cookie = await h.registerPc('접수대');
    const { tab } = await alarmOnTab(h, cookie, { answer: false });
    const silent = await addHospitalRequest(h.pool, h.hospitalId);
    const alarmOff = nextEvent<AlarmOff>(tab as Socket, 'hospital.alarm_off');
    assert.deepEqual(await deliver(h, [silent]), { delivered: [], failed: [silent] });
    assert.equal((await hreq(h, silent)).status, 'delivery_failed');
    assert.equal((await alarmOff).data.reason, 'no_ack');
  });
});

test('새 요청: 이미 대기가 아닌 요청은 보내지 않는다', async () => {
  await withLiveHospitalWeb(async (h) => {
    const cookie = await h.registerPc('접수대');
    const { tab } = await alarmOnTab(h, cookie);
    let got = false;
    tab.on('request.new', () => (got = true));
    const closed = await addHospitalRequest(h.pool, h.hospitalId, {
      status: 'closed',
      closedReason: 'cancelled',
    });
    assert.deepEqual(await deliver(h, [closed]), { delivered: [], failed: [] });
    assert.equal(got, false);
    assert.equal((await hreq(h, closed)).status, 'closed');
  });
});
