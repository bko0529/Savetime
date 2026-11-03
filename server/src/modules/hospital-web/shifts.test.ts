// SFR-117 인수 기준(근무 시작 → 알림 켜기 → 그 탭만 요청 대상, 재연결 복구, 근무 종료)을
// 임시 DB·실제 Redis·실제 웹소켓 연결로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alarmMembers,
  connected,
  connectError,
  nextEvent,
  resume,
  withLiveHospitalWeb as withShiftApp,
  type AlarmOff,
} from '../../testing/hospitalLive.js';

test('등록 PC 쿠키가 없거나 다른 사이트에서 오면 실시간 연결을 거절한다', async () => {
  await withShiftApp(async (h) => {
    assert.equal(await connectError(h.openTab()), 'PC_NOT_REGISTERED');
    assert.equal(await connectError(h.openTab('st_pc=made-up')), 'PC_NOT_REGISTERED');
    const cookie = await h.registerPc('접수대');
    assert.equal(
      await connectError(h.openTab(cookie, 'https://evil.example')),
      'ORIGIN_NOT_ALLOWED',
    );
  });
});

test('근무 시작 → 알림 켜기를 누른 탭만 요청 대상 방에 들어간다', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const tab = h.openTab(cookie);
    const other = h.openTab(cookie); // 같은 PC 의 다른 탭 (알림 안 켬)
    const tabId = await connected(tab);
    await connected(other);

    const started = await h.post('/hw/shifts', cookie, { staffName: ' 박서연 ' });
    assert.equal(started.status, 201);
    const { shiftId } = started.body;
    let session = await h.session(cookie);
    assert.deepEqual(session.body.shift, { id: shiftId, staffName: '박서연', alarmOn: false });
    assert.deepEqual(await alarmMembers(h), []);

    const on = await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: tabId });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { shiftId });
    assert.deepEqual(await alarmMembers(h), [tabId]);
    session = await h.session(cookie);
    assert.equal(session.body.shift.alarmOn, true);
  });
});

test('근무 전이거나 남의 PC 연결 id 면 알림을 켜지 않는다', async () => {
  await withShiftApp(async (h) => {
    const mine = await h.registerPc('접수대');
    const theirs = await h.registerPc('처치실');
    const myTab = await connected(h.openTab(mine));
    const theirTab = await connected(h.openTab(theirs));

    const early = await h.post('/hw/shifts/current/alarm-on', mine, { socketId: myTab });
    assert.equal(early.status, 404);
    assert.equal(early.body.error.code, 'NOT_FOUND');

    await h.post('/hw/shifts', mine, { staffName: '박서연' });
    const stolen = await h.post('/hw/shifts/current/alarm-on', mine, { socketId: theirTab });
    assert.equal(stolen.status, 404);
    const missing = await h.post('/hw/shifts/current/alarm-on', mine, { socketId: 'gone' });
    assert.equal(missing.status, 404);
    assert.deepEqual(await alarmMembers(h), []);
    const { rows } = await h.pool.query('SELECT alarm_on_at FROM hospital_shift');
    assert.equal(rows[0].alarm_on_at, null);
  });
});

test('연결만 끊겼다 붙으면 같은 근무 id 로 알림을 되살리고, 다른 근무 id 는 거절한다', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const first = h.openTab(cookie);
    const { shiftId } = (await h.post('/hw/shifts', cookie, { staffName: '박서연' })).body;
    await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: await connected(first) });

    first.disconnect();
    const again = h.openTab(cookie); // 다시 붙으면 연결 id 가 바뀐다
    const againId = await connected(again);
    assert.deepEqual(await alarmMembers(h), []);

    assert.deepEqual(await resume(again, shiftId + 1), { ok: false });
    assert.deepEqual(await resume(again, 'abc'), { ok: false });
    assert.deepEqual(await resume(again, shiftId), { ok: true });
    assert.deepEqual(await alarmMembers(h), [againId]);
  });
});

test('알림을 안 켠 근무는 되살리지 않는다 (새로고침한 탭은 다시 눌러야 한다)', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const tab = h.openTab(cookie);
    await connected(tab);
    const { shiftId } = (await h.post('/hw/shifts', cookie, { staffName: '박서연' })).body;
    assert.deepEqual(await resume(tab, shiftId), { ok: false });
  });
});

test('근무 종료 → 이 PC 탭들이 요청 대상에서 빠지고 alarm_off(shift_ended)를 받는다', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const otherPc = await h.registerPc('처치실');
    const tab = h.openTab(cookie);
    const otherTab = h.openTab(otherPc);
    const { shiftId } = (await h.post('/hw/shifts', cookie, { staffName: '박서연' })).body;
    await h.post('/hw/shifts', otherPc, { staffName: '김도윤' });
    await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: await connected(tab) });
    const otherId = await connected(otherTab);
    await h.post('/hw/shifts/current/alarm-on', otherPc, { socketId: otherId });

    const off = nextEvent<AlarmOff>(tab, 'hospital.alarm_off');
    const res = await h.post('/hw/shifts/current/end', cookie);
    assert.equal(res.status, 204);
    const event = await off;
    assert.equal(event.data.reason, 'shift_ended');
    assert.match(event.room, /^pc:\d+$/);
    // 다른 PC 는 그대로 요청 대상
    assert.deepEqual(await alarmMembers(h), [otherId]);

    assert.equal((await h.session(cookie)).body.shift, null);
    assert.deepEqual(await resume(tab, shiftId), { ok: false });
    assert.equal((await h.post('/hw/shifts/current/end', cookie)).status, 404);
  });
});

test('알림 켠 근무 중에 근무를 새로 시작하면 앞 근무를 끝내고 하나만 남긴다', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    const tab = h.openTab(cookie);
    await h.post('/hw/shifts', cookie, { staffName: '박서연' });
    await h.post('/hw/shifts/current/alarm-on', cookie, { socketId: await connected(tab) });

    const off = nextEvent<AlarmOff>(tab, 'hospital.alarm_off');
    const next = await h.post('/hw/shifts', cookie, { staffName: '김도윤' });
    assert.equal(next.status, 201);
    assert.equal((await off).data.reason, 'shift_ended');
    assert.deepEqual(await alarmMembers(h), []);
    const { rows } = await h.pool.query(
      'SELECT staff_name FROM hospital_shift WHERE ended_at IS NULL',
    );
    assert.deepEqual(rows, [{ staff_name: '김도윤' }]);
  });
});

test('담당자 이름이 비었거나 40자를 넘으면 400', async () => {
  await withShiftApp(async (h) => {
    const cookie = await h.registerPc('접수대');
    for (const staffName of ['  ', '가'.repeat(41)]) {
      const res = await h.post('/hw/shifts', cookie, { staffName });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    }
  });
});
