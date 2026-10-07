// =====================================================================
// 세이브타임 상태 전이 v0.2 (서버 코드에 그대로 복사해서 사용)
// 기준: 요구사항분석서 v0.115 부록 A(이송 건) · A-2(병원 요청) — 표의 행 번호를 note에 적어 둠
// 규칙
//  1) 상태를 바꾸는 코드는 반드시 transitionTransport()/transitionHreq()를 거친다. 표에 없는 전이는 전부 거부.
//  2) 검사 순서: 표 → 상태 조건 → 시간·사유 → 버전 (그래야 오류 코드가 정확함)
//  3) 사용자 행동은 version 필수(SFR-160). 타이머·시스템 사건만 예외.
//  4) transport.version은 transport 행이 바뀔 때만 +1 (병원 응답은 hospital_request.version만 올림). 시작값 1
//  5) 행 잠금 순서: 항상 transport를 먼저 FOR UPDATE → 그다음 hospital_request(id 오름차순). 병원 API도 요청에서 transport_id를 찾아
//     transport부터 잠근다 (대원 '도착'과 병원 '승인 취소'가 동시에 와도 교착 없이 먼저 온 것 하나만 반영, SFR-160·153)
// =====================================================================

export class TransitionError extends Error {
  constructor(public code: ErrorCode, msg: string) { super(msg); }
}
export type ErrorCode =
  | 'INVALID_TRANSITION' | 'VERSION_REQUIRED' | 'VERSION_CONFLICT' | 'ACTIVE_TRANSPORT_EXISTS'
  | 'REQUEST_NOT_APPROVED' | 'APPROVAL_EXPIRED' | 'APPROVAL_CANCELLED'
  | 'ALREADY_RESPONDED' | 'REQUEST_EXPIRED' | 'REQUEST_CLOSED' | 'REASON_REQUIRED'
  | 'WINDOW_PASSED' | 'DESTINATION_CHANGE_USED' | 'MAX_RADIUS' | 'NO_REQUEST_TARGET'
  | 'RE_REQUEST_NOT_ALLOWED' | 'OVER_APPROVAL_CONFIRM_REQUIRED';

// ---------------- 1. 이송 건 (transport.status) — 부록 A ----------------
export type TransportStatus = 'requesting' | 'fallback' | 'phone_check' | 'moving' | 'arrived' | 'cancelled';
export const ACTIVE: TransportStatus[] = ['requesting', 'fallback', 'phone_check', 'moving'];

export type TransportEvent =
  | 'CREATE_WITH_TARGETS'          // A4  병원에 요청, 대상 1곳 이상·온라인
  | 'CREATE_NO_TARGET'             // A5  대상 0곳 (통신 두절 건은 복구 때 sync로 같은 사건)
  | 'HOSPITAL_RESPONDED'           // A6  병원 승인·거절 도착 (상태 유지, 화면 갱신)
  | 'CONFIRM'                      // A7  승인 병원 1곳 선택
  | 'NO_OPEN_REQUEST'              // A8·A10 + SFR-161: 대기 0곳·유효 승인 0곳 (전부 거절·2분 승인 0·전달 0곳·승인 취소로 0)
  | 'GO_FALLBACK'                  // A8  '기다리지 않고 예비로'
  | 'APPROVAL_WINDOW_ENDED'        // A9  요청 후 5분 동안 선택 없음
  | 'APPROVAL_CANCELLED_OPEN_REMAIN' // A10 승인 취소됐지만 대기·유효 승인이 남음 (상태 유지)
  | 'ASSESSMENT_UPDATED'           // A11 변경 사항 보내기 (상태 유지)
  | 'EXPAND_ROUND'                 // A12 '반경 넓혀 다시 요청'
  | 'START_PHONE_CHECK'            // A13 추천 병원 '경로 안내'
  | 'PHONE_ACCEPTED'               // A14 수용 확정
  | 'PHONE_PROCEED'                // A15 연결 실패·확인 생략 + 사유
  | 'PHONE_REJECTED_NEXT'          // A16 거절, 남은 후보 있음
  | 'PHONE_REJECTED_LAST'          // A17 거절, 남은 후보 없음
  | 'PHONE_DISMISSED'              // A18 결과 선택 없이 닫기
  | 'ARRIVE'                       // A19 도착 버튼·메뉴·병원 웹 도착 확인
  | 'CONFIRMED_HOSPITAL_CANCELLED' // A20 목적지 병원이 승인 취소 (상태 유지 + 경보)
  | 'RE_REQUEST'                   // A20·A21 승인 취소 뒤 '다시 요청'
  | 'CHANGE_DESTINATION'           // A21 목적지 변경 (1번)
  | 'FINISH_PREVIOUS'              // A23 도착을 잊은 채 새 요청 → '이전 이송 끝내기'
  | 'CANCEL';                      // A24·A28·A29 이송 취소 / 2시간 자동 종료 / 마지막 대원 근무 종료·로그아웃·탈퇴·정지

export type CancelReason = 'user' | 'auto_inactive' | 'duty_end' | 'logout' | 'withdrawal' | 'suspended' | 'offline_superseded';
// offline_superseded: 통신 두절 중 만든 건이 복구 때 같은 팀의 다른 진행 중 건과 겹침 → 서버 건을 남기고 오프라인 건은 이력으로 (SFR-099, 부록 A30)
export type ArrivalMethod = 'button' | 'menu' | 'hospital' | 'finish_previous';
export type FallbackReason = 'no_target' | 'offline' | 'all_rejected' | 'expired_no_approval' | 'none_delivered'
  | 'approvals_cancelled' | 'user' | 'approval_window' | 'phone_rejected_last' | 'phone_dismissed';
export type PhoneProceedReason = 'no_answer' | 'busy' | 'urgent' | 'etc';
export type DestChangeReason = 'patient_change' | 'road' | 'hospital' | 'etc';

type Row<S, E> = { from: S | null; event: E; to: S; user: boolean; ref: string; note: string };
const T = (from: TransportStatus | null, event: TransportEvent, to: TransportStatus, user: boolean, ref: string, note: string): Row<TransportStatus, TransportEvent> =>
  ({ from, event, to, user, ref, note });

export const TRANSPORT_TABLE: Row<TransportStatus, TransportEvent>[] = [
  T(null,          'CREATE_WITH_TARGETS', 'requesting', true,  'A4',  '회차 1 생성 → 병원 요청 SEND'),
  T(null,          'CREATE_NO_TARGET',    'fallback',   true,  'A5',  '사유 no_target / offline'),
  T('requesting',  'HOSPITAL_RESPONDED',  'requesting', false, 'A6',  '대원 화면 갱신, 첫 승인은 알림'),
  T('requesting',  'CONFIRM',             'moving',     true,  'A7',  '나머지 대기·승인 → 다른 병원으로 이송, 출발 시각(처음만), 경로 안내 담당 단말 지정'),
  T('requesting',  'NO_OPEN_REQUEST',     'fallback',   false, 'A8·A10', '사유 all_rejected / expired_no_approval / none_delivered / approvals_cancelled'),
  T('requesting',  'GO_FALLBACK',         'fallback',   true,  'A8',  '대기·승인 요청 → 요청 종료'),
  T('requesting',  'APPROVAL_WINDOW_ENDED','fallback',  false, 'A9',  '승인 요청 → 요청 종료(5분)'),
  T('requesting',  'APPROVAL_CANCELLED_OPEN_REMAIN', 'requesting', false, 'A10', "해당 병원 '승인 취소' 표시"),
  T('requesting',  'ASSESSMENT_UPDATED',  'requesting', true,  'A11', '대기·승인 병원에 강조 표시'),
  T('requesting',  'CANCEL',              'cancelled',  true,  'A24·A28·A29', '열린 요청 → 취소됨'),
  T('fallback',    'EXPAND_ROUND',        'requesting', true,  'A12', '반경 한 단계, 아직 요청 안 한 병원에만 새 회차'),
  T('fallback',    'START_PHONE_CHECK',   'phone_check',true,  'A13', '대상 병원 기록'),
  T('fallback',    'CANCEL',              'cancelled',  true,  'A24', ''),
  T('phone_check', 'PHONE_ACCEPTED',      'moving',     true,  'A14', '결과·시각, 출발 시각(처음만)'),
  T('phone_check', 'PHONE_PROCEED',       'moving',     true,  'A15', '연결 실패·확인 생략, 사유 필수'),
  T('phone_check', 'PHONE_REJECTED_NEXT', 'phone_check',true,  'A16', '제외 병원 추가(통계 제외), 대상 병원을 다음 후보로'),
  T('phone_check', 'PHONE_REJECTED_LAST', 'fallback',   true,  'A17', '40km 미만이면 반경 확장 안내, 40km면 전화 안내'),
  T('phone_check', 'PHONE_DISMISSED',     'fallback',   true,  'A18', "사유 '결과 미선택'"),
  T('phone_check', 'CANCEL',              'cancelled',  true,  'A24', ''),
  T('moving',      'ASSESSMENT_UPDATED',  'moving',     true,  'A11', '확정 병원 도착 예정 목록에 강조'),
  T('moving',      'ARRIVE',              'arrived',    true,  'A19', '방법 button/menu/hospital, 익명 소요시간, 원본 위치 삭제. 병원 웹 도착 확인(200m 안)은 서버 판단이라 version 없이'),
  T('moving',      'CONFIRMED_HOSPITAL_CANCELLED', 'moving', false, 'A20', "경보 + '다시 요청' 버튼, 경로 안내 유지, 자동 재요청 없음"),
  T('moving',      'RE_REQUEST',          'requesting', true,  'A20·A21', '확정 병원이 승인 취소한 경우만. 제외 병원만 빼고 현재 반경, 직전 승인 병원에 재확인 표시. 경로 안내 유지'),
  T('moving',      'CHANGE_DESTINATION',  'requesting', true,  'A21', '1번만, 사유 필수. 이전 목적지 → 닫힘(목적지 변경)·제외, 현재 위치 기준 새 회차. 경로 안내 유지'),
  T('moving',      'FINISH_PREVIOUS',     'arrived',    true,  'A23', "도착 방법 'finish_previous', 같은 트랜잭션에서 새 이송 건 생성"),
  T('moving',      'CANCEL',              'cancelled',  true,  'A24', '확정 병원 → 취소됨'),
];

/** 부록 A30: 통신 두절 중 단말에 보관했다가 복구 때 보내는 사건 (나머지 — 확정·취소·목적지 변경·요청 — 은 보관하지 않고 막는다)
 *  CREATE_NO_TARGET은 오프라인 예비 추천 건 등록(A5, SFR-099) */
export const OFFLINE_QUEUEABLE: TransportEvent[] = [
  'CREATE_NO_TARGET', 'PHONE_ACCEPTED', 'PHONE_PROCEED', 'PHONE_REJECTED_NEXT', 'PHONE_REJECTED_LAST', 'PHONE_DISMISSED', 'ARRIVE',
];
/** 표에 행이 없는 부록 A 항목 — 상태를 바꾸지 않으므로 코드로 처리하는 곳만 적어 둠
 *  A22 도착·취소 후 10분 안 새 요청 = 새 이송 건 CREATE_* (prevTransportId로 제외 병원 이어받기)
 *  A25 고른 병원 승인 무효 = CONFIRM이 APPROVAL_CANCELLED·APPROVAL_EXPIRED로 거부 → 상태 유지
 *  A26 재실행 = 전이 없음 (GET /transports/current로 화면 복구)
 *  A27 새 요청 시도 = CREATE_*가 ACTIVE_TRANSPORT_EXISTS로 거부
 *  A28·A29 = CANCEL + cancelReason (auto_inactive / duty_end·logout·withdrawal·suspended), 버전 없이 */
export const APPENDIX_A_NO_ROW = ['A22', 'A25', 'A26', 'A27', 'A28', 'A29', 'A30'] as const;

// ---------------- 2. 병원 요청 (hospital_request.status) — 부록 A-2 ----------------
export type HreqStatus = 'waiting' | 'delivery_failed' | 'approved' | 'rejected' | 'expired' | 'closed' | 'confirmed' | 'arrived' | 'unacceptable';
export type HreqEvent =
  | 'SEND' | 'NO_ACK_5S' | 'APPROVE' | 'REJECT' | 'PAUSE_AUTO_REJECT' | 'RESPOND_TIMEOUT'
  | 'OTHER_CONFIRMED' | 'TRANSPORT_FALLBACK' | 'TRANSPORT_CANCEL' | 'CONFIRM_THIS'
  | 'APPROVAL_TIMEOUT' | 'CANCEL_APPROVAL' | 'DEST_CHANGED' | 'ARRIVE' | 'UNACCEPTABLE';
export type CloseReason = 'other_hospital' | 'fallback' | 'cancelled' | 'expired_approval' | 'approval_cancelled' | 'dest_changed';

type HRow = Row<HreqStatus, HreqEvent> & { closeReason?: CloseReason; inStats?: boolean };
const H = (from: HreqStatus | null, event: HreqEvent, to: HreqStatus, user: boolean, ref: string, note: string, extra: Partial<HRow> = {}): HRow =>
  ({ from, event, to, user, ref, note, ...extra });

export const HREQ_TABLE: HRow[] = [
  H(null,        'SEND',              'waiting',         false, 'A-2 34', '남은 시간 2:00'),
  H('waiting',   'NO_ACK_5S',         'delivery_failed', false, 'A-2 35', '그 회차에서 재전송 없음'),
  H('waiting',   'APPROVE',           'approved',        true,  'A-2 36', '먼저 반영된 PC만, 메모 50자'),
  H('waiting',   'REJECT',            'rejected',        true,  'A-2 37', '사유 필수, 제외 병원 추가', { inStats: true }),
  H('waiting',   'PAUSE_AUTO_REJECT', 'rejected',        false, 'A-2 38', '사유: 요청 중지, 제외 병원 아님', { inStats: false }),
  H('waiting',   'RESPOND_TIMEOUT',   'expired',         false, 'A-2 39', '버튼 비활성'),
  H('waiting',   'OTHER_CONFIRMED',   'closed',          false, 'A-2 40', '', { closeReason: 'other_hospital' }),
  H('approved',  'OTHER_CONFIRMED',   'closed',          false, 'A-2 40', '', { closeReason: 'other_hospital' }),
  H('waiting',   'TRANSPORT_FALLBACK','closed',          false, 'A-2 41', '', { closeReason: 'fallback' }),
  H('approved',  'TRANSPORT_FALLBACK','closed',          false, 'A-2 41', '', { closeReason: 'fallback' }),
  H('waiting',   'TRANSPORT_CANCEL',  'closed',          false, 'A-2 41', '', { closeReason: 'cancelled' }),
  H('approved',  'TRANSPORT_CANCEL',  'closed',          false, 'A-2 41', '', { closeReason: 'cancelled' }),
  H('approved',  'CONFIRM_THIS',      'confirmed',       false, 'A-2 42', '도착 예정 목록에 추가'),
  H('approved',  'APPROVAL_TIMEOUT',  'closed',          false, 'A-2 43', '', { closeReason: 'expired_approval' }),
  H('approved',  'CANCEL_APPROVAL',   'closed',          true,  'A-2 44', '사유 필수, 제외 병원 추가', { closeReason: 'approval_cancelled' }),
  H('confirmed', 'CANCEL_APPROVAL',   'closed',          true,  'A-2 44', '사유 필수, 대원 경보, 제외 병원 추가', { closeReason: 'approval_cancelled' }),
  H('confirmed', 'DEST_CHANGED',      'closed',          false, 'A-2 45', '병원 웹에 목적지 변경 표시, 제외 병원 추가', { closeReason: 'dest_changed' }),
  H('confirmed', 'TRANSPORT_CANCEL',  'closed',          false, 'A-2 45', '', { closeReason: 'cancelled' }),
  H('confirmed', 'ARRIVE',            'arrived',         false, 'A-2 46', '환자 정보 열람은 도착 후 1시간까지'),
  H('arrived',   'UNACCEPTABLE',      'unacceptable',    true,  'A-2 47', '10분 안, 사유 필수, 다음 이송에서 제외'),
];

/** 병원이 환자 평가 정보를 볼 수 있는가 (SER-014). arrived는 도착 후 1시간까지 */
export function hreqCanViewPatient(status: HreqStatus, now: Date, arrivedAt?: Date | null): boolean {
  if (status === 'waiting' || status === 'approved' || status === 'confirmed') return true;
  if (status === 'arrived' && arrivedAt) return now.getTime() - arrivedAt.getTime() < 60 * 60_000;
  return false;
}

// ---------------- 3. 연쇄 (같은 트랜잭션) ----------------
/** 연쇄 대상 = 현재(가장 최근) 회차와 확정 요청 중 아래 상태인 것 */
export const TARGET_STATES = {
  open: ['waiting', 'approved'] as HreqStatus[],
  approved: ['approved'] as HreqStatus[],
  confirmed: ['confirmed'] as HreqStatus[],
  open_or_confirmed: ['waiting', 'approved', 'confirmed'] as HreqStatus[],
};
export type CascadeTarget = keyof typeof TARGET_STATES | 'chosen' | 'new_round';

/** 이송 건 사건 → 병원 요청 사건 */
export const CASCADE: Partial<Record<TransportEvent, { target: CascadeTarget; event: HreqEvent }[]>> = {
  CREATE_WITH_TARGETS:   [{ target: 'new_round', event: 'SEND' }],
  CONFIRM:               [{ target: 'chosen', event: 'CONFIRM_THIS' }, { target: 'open', event: 'OTHER_CONFIRMED' }], // open = 선택한 것 제외
  GO_FALLBACK:           [{ target: 'open', event: 'TRANSPORT_FALLBACK' }],
  APPROVAL_WINDOW_ENDED: [{ target: 'approved', event: 'APPROVAL_TIMEOUT' }],
  EXPAND_ROUND:          [{ target: 'new_round', event: 'SEND' }],
  RE_REQUEST:            [{ target: 'new_round', event: 'SEND' }],
  CHANGE_DESTINATION:    [{ target: 'confirmed', event: 'DEST_CHANGED' }, { target: 'new_round', event: 'SEND' }],
  ARRIVE:                [{ target: 'confirmed', event: 'ARRIVE' }],
  FINISH_PREVIOUS:       [{ target: 'confirmed', event: 'ARRIVE' }],
  CANCEL:                [{ target: 'open_or_confirmed', event: 'TRANSPORT_CANCEL' }],
};

/** 병원 요청이 바뀐 뒤 → 이송 건에 일어날 사건 (역방향 연쇄). 서버는 병원 요청을 바꾼 같은 트랜잭션에서 부른다 */
export interface RoundCounts { waiting: number; validApproved: number }
export function transportEventAfterHreqChange(
  transport: TransportStatus, changed: { event: HreqEvent; fromStatus: HreqStatus }, counts: RoundCounts,
): { event: TransportEvent; reason?: FallbackReason } | null {
  if (transport === 'moving' && changed.event === 'CANCEL_APPROVAL' && changed.fromStatus === 'confirmed')
    return { event: 'CONFIRMED_HOSPITAL_CANCELLED' };
  if (transport !== 'requesting') return null;
  // 5분 해제는 정방향(APPROVAL_WINDOW_ENDED → 연쇄 APPROVAL_TIMEOUT)으로만 처리. 타이머는 이송 건 사건을 먼저 부른다
  if (changed.event === 'APPROVAL_TIMEOUT') return null;
  if (counts.waiting === 0 && counts.validApproved === 0) {
    const reason: FallbackReason =
      changed.event === 'NO_ACK_5S' ? 'none_delivered'
      : changed.event === 'RESPOND_TIMEOUT' ? 'expired_no_approval'
      : changed.event === 'CANCEL_APPROVAL' ? 'approvals_cancelled'
      : 'all_rejected';
    return { event: 'NO_OPEN_REQUEST', reason };
  }
  if (changed.event === 'CANCEL_APPROVAL') return { event: 'APPROVAL_CANCELLED_OPEN_REMAIN' };
  if (changed.event === 'APPROVE' || changed.event === 'REJECT' || changed.event === 'PAUSE_AUTO_REJECT') return { event: 'HOSPITAL_RESPONDED' };
  return null;
}

/** 전화 확인 결과 → 사건 */
export function phoneEvent(result: 'accepted' | 'no_answer' | 'skipped' | 'rejected' | 'dismissed', hasNextCandidate: boolean): TransportEvent {
  if (result === 'accepted') return 'PHONE_ACCEPTED';
  if (result === 'no_answer' || result === 'skipped') return 'PHONE_PROCEED';
  if (result === 'rejected') return hasNextCandidate ? 'PHONE_REJECTED_NEXT' : 'PHONE_REJECTED_LAST';
  return 'PHONE_DISMISSED';
}

// ---------------- 4. 전이 함수 ----------------
const RADIUS_STEPS = [10, 20, 30, 40];

function findRow<R extends { from: unknown; event: unknown }>(table: R[], from: unknown, event: unknown): R {
  const r = table.find(t => t.from === from && t.event === event);
  if (!r) throw new TransitionError('INVALID_TRANSITION', `${String(from)} 상태에서 ${String(event)} 불가`);
  return r;
}

export interface TransportCtx {
  now: Date;
  version: number;                // 서버의 transport.version (DB 기본 1, 생성은 버전 대신 앱 UUID로 중복 방지)
  clientVersion?: number;         // 사용자 요청에 필수
  teamHasOtherActive?: boolean;   // 생성 시
  target?: { status: HreqStatus; closeReason?: CloseReason | null; approvalValidUntil: Date }; // CONFIRM 대상 병원 요청
  confirmedReqClosedReason?: CloseReason | null; // RE_REQUEST: 확정 병원 요청이 닫힌 이유
  destinationChangedBefore?: boolean;
  currentRadiusKm?: number; nextRadiusKm?: number; newTargetCount?: number; // EXPAND_ROUND·RE_REQUEST·CHANGE_DESTINATION
  cancelReason?: CancelReason; arrivalMethod?: ArrivalMethod;
  phoneReason?: PhoneProceedReason | null; destReason?: DestChangeReason | null; fallbackReason?: FallbackReason;
}
export interface TransportResult { to: TransportStatus; history: { from: TransportStatus | null; to: TransportStatus; event: TransportEvent; reason: string | null; at: Date } }

export function transitionTransport(from: TransportStatus | null, event: TransportEvent, ctx: TransportCtx): TransportResult {
  // ① 표
  const row = findRow(TRANSPORT_TABLE, from, event);
  // 사용자 취소인지 시스템 취소인지에 따라 버전 필수 여부가 다름
  const isUser = event === 'CANCEL' ? (ctx.cancelReason ?? 'user') === 'user'
    : event === 'ARRIVE' && ctx.arrivalMethod === 'hospital' ? false   // 병원 웹 '도착 확인'은 서버가 위치(200m)로 판단
    : row.user;
  let reason: string | null = null;
  // ② 상태 조건
  switch (event) {
    case 'CREATE_WITH_TARGETS': case 'CREATE_NO_TARGET':
      if (ctx.teamHasOtherActive) throw new TransitionError('ACTIVE_TRANSPORT_EXISTS', '팀에 진행 중 이송이 있어요');
      reason = event === 'CREATE_NO_TARGET' ? (ctx.fallbackReason ?? 'no_target') : null;
      break;
    case 'CONFIRM': {
      const t = ctx.target;
      if (!t) throw new TransitionError('REQUEST_NOT_APPROVED', '대상 병원 요청이 없어요');
      if (t.status === 'closed' && t.closeReason === 'approval_cancelled') throw new TransitionError('APPROVAL_CANCELLED', '병원이 승인을 취소했어요');
      if ((t.status === 'closed' && t.closeReason === 'expired_approval') || (t.status === 'approved' && ctx.now >= t.approvalValidUntil))
        throw new TransitionError('APPROVAL_EXPIRED', '승인 유효 시간(5분)이 지났어요');
      if (t.status !== 'approved') throw new TransitionError('REQUEST_NOT_APPROVED', '승인한 병원만 고를 수 있어요');
      break;
    }
    case 'RE_REQUEST':
      if (ctx.confirmedReqClosedReason !== 'approval_cancelled')
        throw new TransitionError('RE_REQUEST_NOT_ALLOWED', '목적지 병원이 승인을 취소했을 때만 다시 요청할 수 있어요');
      if (ctx.newTargetCount === 0) throw new TransitionError('NO_REQUEST_TARGET', '다시 요청할 병원이 없어요');
      break;
    case 'CHANGE_DESTINATION':
      if (ctx.destinationChangedBefore) throw new TransitionError('DESTINATION_CHANGE_USED', "목적지 변경은 1번만 — '이송 취소' 후 새로 요청하세요");
      if (!ctx.destReason) throw new TransitionError('REASON_REQUIRED', '변경 사유를 골라 주세요');
      if (ctx.newTargetCount === 0) throw new TransitionError('NO_REQUEST_TARGET', '요청할 병원이 없어요');
      reason = ctx.destReason;
      break;
    case 'EXPAND_ROUND': {
      const i = RADIUS_STEPS.indexOf(ctx.currentRadiusKm ?? -1);
      if (i < 0 || i === RADIUS_STEPS.length - 1) throw new TransitionError('MAX_RADIUS', '더 넓힐 반경이 없어요 (최대 40km)');
      if (ctx.nextRadiusKm !== RADIUS_STEPS[i + 1]) throw new TransitionError('MAX_RADIUS', '반경은 한 단계씩만 넓혀요');
      if (ctx.newTargetCount === 0) throw new TransitionError('NO_REQUEST_TARGET', '넓힌 반경에 새 병원이 없어요');
      break;
    }
    case 'PHONE_PROCEED':
      if (!ctx.phoneReason) throw new TransitionError('REASON_REQUIRED', '사유를 골라 주세요');
      reason = ctx.phoneReason;
      break;
    case 'PHONE_DISMISSED': reason = 'phone_dismissed'; break;
    case 'PHONE_REJECTED_LAST': reason = 'phone_rejected_last'; break;
    case 'NO_OPEN_REQUEST': reason = ctx.fallbackReason ?? 'all_rejected'; break;
    case 'GO_FALLBACK': reason = 'user'; break;
    case 'APPROVAL_WINDOW_ENDED': reason = 'approval_window'; break;
    case 'ARRIVE':
      reason = ctx.arrivalMethod ?? 'button';
      if (reason === 'finish_previous') throw new TransitionError('INVALID_TRANSITION', 'finish_previous는 FINISH_PREVIOUS 사건으로');
      break;
    case 'FINISH_PREVIOUS': reason = 'finish_previous'; break;
    case 'CANCEL': reason = ctx.cancelReason ?? 'user'; break;
  }
  // ③ 버전 (사용자 행동만, 생성 제외)
  if (isUser && from !== null) {
    if (ctx.clientVersion === undefined) throw new TransitionError('VERSION_REQUIRED', 'version을 같이 보내야 해요');
    if (ctx.clientVersion !== ctx.version) throw new TransitionError('VERSION_CONFLICT', '그사이 상태가 바뀌었어요');
  }
  return { to: row.to, history: { from, to: row.to, event, reason, at: ctx.now } };
}

export interface HreqCtx {
  now: Date;
  version: number; clientVersion?: number;
  respondUntil?: Date;            // APPROVE·REJECT: 회차 sent_at + 2분
  approvalValidUntil?: Date;      // APPROVAL_TIMEOUT: sent_at + 5분
  arrivedAt?: Date;               // UNACCEPTABLE: 도착 시각 + 10분
  reason?: string | null;         // REJECT·CANCEL_APPROVAL·UNACCEPTABLE 사유 필수
  overApproval?: boolean; overApprovalConfirmed?: boolean; // APPROVE: 유효 승인 수 ≥ 응급실 가용 병상
}
export interface HreqResult { to: HreqStatus; closeReason: CloseReason | null; inStats: boolean }

export function transitionHreq(from: HreqStatus | null, event: HreqEvent, ctx: HreqCtx): HreqResult {
  // 응답 계열은 상태에 따라 정확한 오류 코드부터
  if (event === 'APPROVE' || event === 'REJECT') {
    if (from === 'expired') throw new TransitionError('REQUEST_EXPIRED', '응답 시간(2분)이 지났어요');
    if (from === 'closed' || from === 'delivery_failed') throw new TransitionError('REQUEST_CLOSED', '닫힌 요청이에요');
    if (from !== 'waiting') throw new TransitionError('ALREADY_RESPONDED', '다른 PC에서 먼저 응답했어요');
  }
  if (event === 'CANCEL_APPROVAL' && from !== 'approved' && from !== 'confirmed')
    throw new TransitionError(from === 'closed' ? 'REQUEST_CLOSED' : 'REQUEST_NOT_APPROVED', '승인 상태가 아니에요');
  // ① 표
  const row = findRow(HREQ_TABLE, from, event);
  // ② 시간 조건 (경계는 모두 '이상이면 지남')
  const at = ctx.now.getTime();
  if ((event === 'APPROVE' || event === 'REJECT')) {
    if (!ctx.respondUntil) throw new Error('respondUntil 필요');
    if (at >= ctx.respondUntil.getTime()) throw new TransitionError('REQUEST_EXPIRED', '응답 시간(2분)이 지났어요');
  }
  if (event === 'RESPOND_TIMEOUT' && ctx.respondUntil && at < ctx.respondUntil.getTime()) throw new TransitionError('INVALID_TRANSITION', '아직 2분이 안 됐어요');
  if (event === 'APPROVAL_TIMEOUT' && ctx.approvalValidUntil && at < ctx.approvalValidUntil.getTime()) throw new TransitionError('INVALID_TRANSITION', '아직 5분이 안 됐어요');
  if (event === 'UNACCEPTABLE') {
    if (!ctx.arrivedAt) throw new Error('arrivedAt 필요');
    if (at - ctx.arrivedAt.getTime() >= 10 * 60_000) throw new TransitionError('WINDOW_PASSED', '도착 후 10분이 지났어요');
  }
  // 사유
  if ((event === 'REJECT' || event === 'CANCEL_APPROVAL' || event === 'UNACCEPTABLE') && !ctx.reason)
    throw new TransitionError('REASON_REQUIRED', '사유를 골라 주세요');
  // 과승인 확인 (SFR-154)
  if (event === 'APPROVE' && ctx.overApproval && !ctx.overApprovalConfirmed)
    throw new TransitionError('OVER_APPROVAL_CONFIRM_REQUIRED', '병상보다 많이 승인해요. 한 번 더 확인해 주세요');
  // ③ 버전 (사용자 행동) — 두 PC 동시 응답은 SFR-160·119
  if (row.user) {
    if (ctx.clientVersion === undefined) throw new TransitionError('VERSION_REQUIRED', 'version을 같이 보내야 해요');
    if (ctx.clientVersion !== ctx.version) throw new TransitionError('ALREADY_RESPONDED', '다른 PC에서 먼저 처리했어요');
  }
  return { to: row.to, closeReason: row.closeReason ?? null, inStats: row.inStats ?? true };
}
