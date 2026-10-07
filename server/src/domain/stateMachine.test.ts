import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionTransport as T, transitionHreq as H, TRANSPORT_TABLE, HREQ_TABLE, CASCADE, TARGET_STATES,
  transportEventAfterHreqChange as after, phoneEvent, hreqCanViewPatient, ACTIVE, TransitionError, OFFLINE_QUEUEABLE, APPENDIX_A_NO_ROW,
} from './stateMachine.js';

const now = new Date('2026-10-03T14:12:00Z');
const plus = (s: number) => new Date(now.getTime() + s * 1000);
const code = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e) { return (e as TransitionError).code ?? String(e); } };
const U = (v = 1) => ({ now, version: v, clientVersion: v }); // 사용자 요청 기본값

// ---------- 시나리오 ----------
test('시나리오 ② 한 바퀴: 요청 → 승인 → 확정 → 도착', () => {
  let s = T(null, 'CREATE_WITH_TARGETS', { now, version: 0 }).to;
  assert.equal(s, 'requesting');
  let r = H(null, 'SEND', { now, version: 0 }).to;
  r = H(r, 'APPROVE', { ...U(1), respondUntil: plus(120) }).to;
  assert.equal(after('requesting', { event: 'APPROVE', fromStatus: 'waiting' }, { waiting: 7, validApproved: 1 })?.event, 'HOSPITAL_RESPONDED');
  s = T(s, 'CONFIRM', { ...U(1), now: plus(60), target: { status: 'approved', approvalValidUntil: plus(300) } }).to;
  assert.equal(s, 'moving');
  r = H(r, 'CONFIRM_THIS', { now, version: 2 }).to;
  s = T(s, 'ARRIVE', { ...U(2), arrivalMethod: 'button' }).to;
  r = H(r, 'ARRIVE', { now, version: 3 }).to;
  assert.deepEqual([s, r], ['arrived', 'arrived']);
});

test('갈림길 A: 2분 무승인 → 예비 추천 → 전화 확인 → 거절(다음 후보) → 수용 → 이동', () => {
  assert.deepEqual(after('requesting', { event: 'RESPOND_TIMEOUT', fromStatus: 'waiting' }, { waiting: 0, validApproved: 0 }), { event: 'NO_OPEN_REQUEST', reason: 'expired_no_approval' });
  let s = T('requesting', 'NO_OPEN_REQUEST', { now, version: 1, fallbackReason: 'expired_no_approval' }).to;
  s = T(s, 'START_PHONE_CHECK', U(2)).to;
  assert.equal(s, 'phone_check');
  s = T(s, phoneEvent('rejected', true), U(3)).to;
  assert.equal(s, 'phone_check');
  s = T(s, phoneEvent('accepted', true), U(4)).to;
  assert.equal(s, 'moving');
});

test('전화 확인: 연결 실패·확인 생략은 사유 필수, 마지막 후보 거절·결과 미선택은 예비 추천', () => {
  assert.equal(code(() => T('phone_check', 'PHONE_PROCEED', U())), 'REASON_REQUIRED');
  assert.equal(T('phone_check', 'PHONE_PROCEED', { ...U(), phoneReason: 'no_answer' }).to, 'moving');
  assert.equal(T('phone_check', phoneEvent('rejected', false), U()).to, 'fallback');
  const d = T('phone_check', phoneEvent('dismissed', false), U());
  assert.deepEqual([d.to, d.history.reason], ['fallback', 'phone_dismissed']);
});

test('대상 0곳으로 생성 → fallback (201로 생성됨)', () => {
  const r = T(null, 'CREATE_NO_TARGET', { now, version: 0, fallbackReason: 'offline' });
  assert.deepEqual([r.to, r.history.reason], ['fallback', 'offline']);
});

test('전달 0곳 → 바로 예비 추천 (SFR-161)', () => {
  assert.deepEqual(after('requesting', { event: 'NO_ACK_5S', fromStatus: 'waiting' }, { waiting: 0, validApproved: 0 }), { event: 'NO_OPEN_REQUEST', reason: 'none_delivered' });
});

test('승인 취소: 남은 요청 있으면 유지, 0곳이면 예비 추천 (부록 A10)', () => {
  assert.equal(after('requesting', { event: 'CANCEL_APPROVAL', fromStatus: 'approved' }, { waiting: 2, validApproved: 0 })?.event, 'APPROVAL_CANCELLED_OPEN_REMAIN');
  assert.deepEqual(after('requesting', { event: 'CANCEL_APPROVAL', fromStatus: 'approved' }, { waiting: 0, validApproved: 0 }), { event: 'NO_OPEN_REQUEST', reason: 'approvals_cancelled' });
});

test('갈림길 C: 이동 중 확정 병원 승인 취소 → 이동 유지 → 다시 요청만 가능', () => {
  assert.equal(after('moving', { event: 'CANCEL_APPROVAL', fromStatus: 'confirmed' }, { waiting: 0, validApproved: 0 })?.event, 'CONFIRMED_HOSPITAL_CANCELLED');
  assert.equal(T('moving', 'CONFIRMED_HOSPITAL_CANCELLED', { now, version: 3 }).to, 'moving');
  assert.equal(T('moving', 'RE_REQUEST', { ...U(3), confirmedReqClosedReason: 'approval_cancelled', newTargetCount: 6 }).to, 'requesting');
});

test('이동 중 다시 요청은 확정 병원이 승인 취소했을 때만 (A20)', () => {
  assert.equal(code(() => T('moving', 'RE_REQUEST', { ...U(), confirmedReqClosedReason: null })), 'RE_REQUEST_NOT_ALLOWED');
});

test('이동 중 예비 추천으로 가는 길은 없음 (부록 A, 결정 A)', () => {
  assert.equal(code(() => T('moving', 'GO_FALLBACK', U())), 'INVALID_TRANSITION');
});

test('목적지 변경: 요청 중으로, 사유 필수, 1번만 (A21, SFR-077)', () => {
  assert.equal(T('moving', 'CHANGE_DESTINATION', { ...U(), destReason: 'road', newTargetCount: 5 }).to, 'requesting');
  assert.equal(code(() => T('moving', 'CHANGE_DESTINATION', { ...U(), newTargetCount: 5 })), 'REASON_REQUIRED');
  assert.equal(code(() => T('moving', 'CHANGE_DESTINATION', { ...U(), destReason: 'road', destinationChangedBefore: true })), 'DESTINATION_CHANGE_USED');
  assert.deepEqual(CASCADE.CHANGE_DESTINATION?.map(c => c.event), ['DEST_CHANGED', 'SEND']);
});

test('이전 이송 끝내기 (A23, SFR-104)', () => {
  const r = T('moving', 'FINISH_PREVIOUS', U());
  assert.deepEqual([r.to, r.history.reason], ['arrived', 'finish_previous']);
});

test('반경 넓히기: 한 단계씩, 40km면 불가, 새 병원 0곳이면 불가 (SFR-131)', () => {
  assert.equal(T('fallback', 'EXPAND_ROUND', { ...U(), currentRadiusKm: 20, nextRadiusKm: 30, newTargetCount: 3 }).to, 'requesting');
  assert.equal(code(() => T('fallback', 'EXPAND_ROUND', { ...U(), currentRadiusKm: 20, nextRadiusKm: 40, newTargetCount: 3 })), 'MAX_RADIUS');
  assert.equal(code(() => T('fallback', 'EXPAND_ROUND', { ...U(), currentRadiusKm: 40, nextRadiusKm: 40 })), 'MAX_RADIUS');
  assert.equal(code(() => T('fallback', 'EXPAND_ROUND', { ...U(), currentRadiusKm: 30, nextRadiusKm: 20 })), 'MAX_RADIUS');
  assert.equal(code(() => T('fallback', 'EXPAND_ROUND', { ...U(), currentRadiusKm: 20, nextRadiusKm: 30, newTargetCount: 0 })), 'NO_REQUEST_TARGET');
});

test('취소: 진행 중 4개 상태 모두 가능, 종료 상태는 불가, 시스템 취소는 버전 없이', () => {
  for (const s of ACTIVE) assert.equal(T(s, 'CANCEL', U()).to, 'cancelled', s);
  assert.equal(code(() => T('arrived', 'CANCEL', U())), 'INVALID_TRANSITION');
  assert.equal(code(() => T('cancelled', 'CANCEL', U())), 'INVALID_TRANSITION');
  const r = T('moving', 'CANCEL', { now, version: 5, cancelReason: 'auto_inactive' });
  assert.equal(r.history.reason, 'auto_inactive');
});

test('v0.2 재검토 반영: 오프라인 건 겹침 취소, 5분 해제는 정방향만, 미승인 요청 승인 취소 코드', () => {
  assert.equal(T('fallback', 'CANCEL', { now, version: 2, cancelReason: 'offline_superseded' }).history.reason, 'offline_superseded');
  assert.equal(after('requesting', { event: 'APPROVAL_TIMEOUT', fromStatus: 'approved' }, { waiting: 0, validApproved: 0 }), null);
  assert.equal(code(() => H('waiting', 'CANCEL_APPROVAL', { ...U(), reason: 'er_bed' })), 'REQUEST_NOT_APPROVED');
});

test('팀당 진행 중 이송 1건', () => {
  assert.equal(code(() => T(null, 'CREATE_WITH_TARGETS', { now, version: 0, teamHasOtherActive: true })), 'ACTIVE_TRANSPORT_EXISTS');
});

// ---------- 확정 ----------
test('확정: 버전 필수·불일치, 5분 경계(300초 정각이면 만료), 취소·만료·미승인 구분', () => {
  const tgt = { status: 'approved' as const, approvalValidUntil: plus(300) };
  assert.equal(code(() => T('requesting', 'CONFIRM', { now, version: 1, target: tgt })), 'VERSION_REQUIRED');
  assert.equal(code(() => T('requesting', 'CONFIRM', { now, version: 4, clientVersion: 3, target: tgt })), 'VERSION_CONFLICT');
  assert.equal(T('requesting', 'CONFIRM', { ...U(), now: plus(299), target: tgt }).to, 'moving');
  assert.equal(code(() => T('requesting', 'CONFIRM', { ...U(), now: plus(300), target: tgt })), 'APPROVAL_EXPIRED');
  assert.equal(code(() => T('requesting', 'CONFIRM', { ...U(), target: { status: 'closed', closeReason: 'expired_approval', approvalValidUntil: plus(300) } })), 'APPROVAL_EXPIRED');
  assert.equal(code(() => T('requesting', 'CONFIRM', { ...U(), target: { status: 'closed', closeReason: 'approval_cancelled', approvalValidUntil: plus(300) } })), 'APPROVAL_CANCELLED');
  assert.equal(code(() => T('requesting', 'CONFIRM', { ...U(), target: { status: 'waiting', approvalValidUntil: plus(300) } })), 'REQUEST_NOT_APPROVED');
  // 버전이 틀려도 승인 취소가 먼저 보임 (검사 순서)
  assert.equal(code(() => T('requesting', 'CONFIRM', { now, version: 4, clientVersion: 3, target: { status: 'closed', closeReason: 'approval_cancelled', approvalValidUntil: plus(300) } })), 'APPROVAL_CANCELLED');
});

test('예비 추천에서 바로 확정 불가 (승인 병원 선택은 요청 중에만)', () => {
  assert.equal(code(() => T('fallback', 'CONFIRM', U())), 'INVALID_TRANSITION');
});

// ---------- 병원 요청 ----------
test('병원 PC 2대 동시 승인 → 나중 PC는 ALREADY_RESPONDED', () => {
  assert.equal(code(() => H('waiting', 'APPROVE', { now, version: 2, clientVersion: 1, respondUntil: plus(120) })), 'ALREADY_RESPONDED');
  assert.equal(code(() => H('approved', 'APPROVE', { now, version: 2, clientVersion: 2, respondUntil: plus(120) })), 'ALREADY_RESPONDED');
});

test('만료·닫힌 요청은 버전과 상관없이 정확한 코드', () => {
  assert.equal(code(() => H('expired', 'APPROVE', { now, version: 3, clientVersion: 1, respondUntil: plus(120) })), 'REQUEST_EXPIRED');
  assert.equal(code(() => H('closed', 'REJECT', { now, version: 3, clientVersion: 1, reason: 'er_bed' })), 'REQUEST_CLOSED');
  assert.equal(code(() => H('delivery_failed', 'APPROVE', { now, version: 1, clientVersion: 1 })), 'REQUEST_CLOSED');
  assert.equal(code(() => H('waiting', 'APPROVE', { ...U(), now: plus(120), respondUntil: plus(120) })), 'REQUEST_EXPIRED');
});

test('사유 필수: 거절·승인 취소·수용 불가', () => {
  assert.equal(code(() => H('waiting', 'REJECT', { ...U(), respondUntil: plus(120) })), 'REASON_REQUIRED');
  assert.equal(code(() => H('confirmed', 'CANCEL_APPROVAL', U())), 'REASON_REQUIRED');
  assert.equal(code(() => H('arrived', 'UNACCEPTABLE', { ...U(), arrivedAt: now })), 'REASON_REQUIRED');
});

test('승인 취소: 닫힌 요청은 REQUEST_CLOSED', () => {
  assert.equal(code(() => H('closed', 'CANCEL_APPROVAL', { ...U(), reason: 'x' })), 'REQUEST_CLOSED');
  assert.equal(H('confirmed', 'CANCEL_APPROVAL', { ...U(), reason: 'er_bed' }).closeReason, 'approval_cancelled');
});

test('과승인 확인 (SFR-154)', () => {
  assert.equal(code(() => H('waiting', 'APPROVE', { ...U(), respondUntil: plus(120), overApproval: true })), 'OVER_APPROVAL_CONFIRM_REQUIRED');
  assert.equal(H('waiting', 'APPROVE', { ...U(), respondUntil: plus(120), overApproval: true, overApprovalConfirmed: true }).to, 'approved');
});

test('잠시 요청 중지: 대기만 자동 거절(통계 제외), 이미 승인한 요청은 그대로 (SFR-139)', () => {
  assert.equal(H('waiting', 'PAUSE_AUTO_REJECT', { now, version: 1 }).inStats, false);
  assert.equal(code(() => H('approved', 'PAUSE_AUTO_REJECT', { now, version: 1 })), 'INVALID_TRANSITION');
});

test('타이머는 시각 전에 돌면 거부', () => {
  assert.equal(code(() => H('waiting', 'RESPOND_TIMEOUT', { now, version: 1, respondUntil: plus(1) })), 'INVALID_TRANSITION');
  assert.equal(code(() => H('approved', 'APPROVAL_TIMEOUT', { now, version: 1, approvalValidUntil: plus(1) })), 'INVALID_TRANSITION');
});

test('수용 불가는 도착 후 10분 미만만 (600초 정각이면 지남)', () => {
  assert.equal(H('arrived', 'UNACCEPTABLE', { ...U(), now: plus(599), arrivedAt: now, reason: 'x' }).to, 'unacceptable');
  assert.equal(code(() => H('arrived', 'UNACCEPTABLE', { ...U(), now: plus(600), arrivedAt: now, reason: 'x' })), 'WINDOW_PASSED');
});

test('환자 정보 열람: 대기·승인·확정 + 도착 후 1시간까지 (SER-014)', () => {
  assert.equal(hreqCanViewPatient('approved', now), true);
  assert.equal(hreqCanViewPatient('closed', now), false);
  assert.equal(hreqCanViewPatient('expired', now), false);
  assert.equal(hreqCanViewPatient('arrived', plus(3599), now), true);
  assert.equal(hreqCanViewPatient('arrived', plus(3600), now), false);
});

// ---------- 표 무결성 ----------
test('표 무결성: 중복 없음, 진행 중 상태 모두 취소 가능, 종료 상태에서 나가는 전이 없음', () => {
  const k1 = TRANSPORT_TABLE.map(r => `${r.from}|${r.event}`); assert.equal(new Set(k1).size, k1.length);
  const k2 = HREQ_TABLE.map(r => `${r.from}|${r.event}`); assert.equal(new Set(k2).size, k2.length);
  for (const s of ACTIVE) assert.ok(TRANSPORT_TABLE.some(r => r.from === s && r.event === 'CANCEL'), s);
  assert.ok(!TRANSPORT_TABLE.some(r => r.from === 'arrived' || r.from === 'cancelled'));
  assert.ok(!TRANSPORT_TABLE.some(r => r.from === 'moving' && r.to === 'fallback'));
});

test('연쇄 대상 × 사건: 대상 상태마다 병원 요청 표에 행이 있음 (트랜잭션 롤백 방지)', () => {
  for (const [tev, list] of Object.entries(CASCADE)) {
    for (const c of list!) {
      if (c.target === 'new_round') { assert.ok(HREQ_TABLE.some(r => r.from === null && r.event === c.event), tev); continue; }
      const states = c.target === 'chosen' ? ['approved'] : TARGET_STATES[c.target];
      for (const st of states) assert.ok(HREQ_TABLE.some(r => r.from === st && r.event === c.event), `${tev}: ${st} ${c.event}`);
    }
  }
});

test('부록 A 행 번호가 모두 표에 반영됨', () => {
  const refs = TRANSPORT_TABLE.map(r => r.ref).join(' ');
  for (const n of ['A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A23', 'A24'])
    assert.ok(refs.includes(n), n);
});

test('부록 A30: 통신 두절 중 보관 가능한 사건만 (확정·취소·목적지 변경·요청은 불가)', () => {
  for (const e of ['CONFIRM', 'CANCEL', 'CHANGE_DESTINATION', 'CREATE_WITH_TARGETS', 'RE_REQUEST', 'EXPAND_ROUND'] as const)
    assert.ok(!OFFLINE_QUEUEABLE.includes(e), e);
  for (const e of OFFLINE_QUEUEABLE) assert.ok(TRANSPORT_TABLE.some(r => r.event === e), e);
});

test('부록 A 4~30행 전부: 표 행 또는 코드 처리 목록에 있음', () => {
  const refs = TRANSPORT_TABLE.map(r => r.ref).join(' ') + ' ' + APPENDIX_A_NO_ROW.join(' ');
  for (let n = 4; n <= 30; n++) assert.ok(new RegExp(`A${n}(?!\\d)`).test(refs), `A${n}`);
});
