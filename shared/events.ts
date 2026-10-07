// =====================================================================
// 세이브타임 실시간 이벤트 타입 v0.2 (서버 · 앱 · 웹 공통)
// 실시간 통신 설계 v0.2 · 상태 전이표 v0.2 · Socket.IO 4.x
// 규칙
//  1) 상태를 바꾸는 일은 REST로, 서버가 "먼저 알려주는" 일만 웹소켓으로.
//  2) payload에는 환자 평가 값(증상·측정값·나이 등)을 넣지 않는다 — ID·개수·항목 이름·시각만 (SER-014, DAR-010).
//     화면에 필요한 상세는 이벤트를 받은 뒤 REST로 가져온다 (병원은 그때 열람 기록이 남음, SFR-137).
//  3) 대상이 바뀌는 이벤트에는 entityVersion을 넣는다 → 오래된 이벤트가 최신 화면을 덮지 않게.
// =====================================================================

/** 모든 이벤트의 공통 머리 */
export interface Envelope<T> {
  seq: number;             // event_log.seq (커밋 순서 = 번호 순서). 앱은 마지막 seq를 기억
  room: string;            // team:12 · paramedic:7 · hospital:3 · hospital:3:on · admin
  occurredAt: string;      // 서버 시각 (ISO 8601)
  serverNow: string;       // 보낼 때 서버 시각 — 남은 시간은 이것 기준으로 계산 (SFR-110)
  entityVersion?: number;  // transport.version 또는 hospital_request.version
  data: T;
}

export type TransportStatus = 'requesting' | 'fallback' | 'phone_check' | 'moving' | 'arrived' | 'cancelled';
export type HreqStatus = 'waiting' | 'delivery_failed' | 'approved' | 'rejected' | 'expired' | 'closed' | 'confirmed' | 'arrived' | 'unacceptable';
export type CloseReason = 'other_hospital' | 'fallback' | 'cancelled' | 'expired_approval' | 'approval_cancelled' | 'dest_changed';
export type CancelReason = 'user' | 'auto_inactive' | 'duty_end' | 'logout' | 'withdrawal' | 'suspended' | 'offline_superseded';
export type FallbackReason = 'no_target' | 'offline' | 'all_rejected' | 'expired_no_approval' | 'none_delivered'
  | 'approvals_cancelled' | 'user' | 'approval_window' | 'phone_rejected_last' | 'phone_dismissed';

/** 대원 앱이 보는 병원 요청 1건 (환자 정보 없음) */
export interface AppHospitalRequest {
  id: number; hospitalId: number; hospitalName: string; lat: number; lng: number; status: HreqStatus;
  etaMin: number; etaSource: 'straight' | 'route'; erBeds: string;
  memo: string | null; extraMemo: string | null; reason: string | null; approvedAt: string | null;
  isClosest: boolean; prevApprovedRecheck: boolean; version: number;
}

// =====================================================================
// A. 서버 → 대원 앱   (/app, 방: team:{teamId} · paramedic:{paramedicId})
// =====================================================================
export interface AppServerEvents {
  // --- 계정 (paramedic 방) ---
  'account.signup_result': (e: Envelope<{ result: 'approved' | 'rejected'; reason: string | null }>) => void;          // 푸시 (SFR-083)
  'account.force_logout':  (e: Envelope<{ reason: 'suspended' | 'pin_failed' | 'withdrawn' }>) => void;              // SER-016

  // --- 팀 ---
  'team.invited':          (e: Envelope<{ inviteId: number; teamCode: string; fromName: string; expiresAt: string }>) => void; // paramedic 방 · 푸시
  'team.invite_result':    (e: Envelope<{ inviteId: number; toName: string; result: 'accepted' | 'declined' | 'expired' }>) => void; // 초대한 사람 (SFR-159)
  'team.member_joined':    (e: Envelope<{ paramedicId: number; name: string; role: 'driver' | 'care' }>) => void;
  'team.member_left':      (e: Envelope<{ paramedicId: number; name: string; reason: 'duty_end' | 'logout' | 'auto_14h' | 'withdrawal' | 'suspended' }>) => void;
  'team.role_changed':     (e: Envelope<{ paramedicId: number; role: 'driver' | 'care' }>) => void;
  'draft.updated':         (e: Envelope<{ version: number; fields: string[]; byName: string; overwritten: { field: string; prevByName: string }[] }>) => void; // 값은 GET /teams/current/draft (SFR-114)

  // --- 이송 건 (team 방, entityVersion = transport.version) ---
  'transport.created':     (e: Envelope<{ transportId: string; status: 'requesting' | 'fallback'; byName: string; fallbackReason: FallbackReason | null }>) => void;
  'round.started':         (e: Envelope<{ transportId: string; roundNo: number; kind: 'first' | 'expand' | 're_request' | 'dest_change'; radiusKm: number; targetCount: number; respondUntil: string; approvalValidUntil: string }>) => void;
  'request.delivered':     (e: Envelope<{ transportId: string; roundNo: number; deliveredCount: number; failedHospitalIds: number[]; final: boolean }>) => void; // final = 5초 판정 끝 (SFR-161)
  'request.eta':           (e: Envelope<{ transportId: string; hospitalRequestId: number; etaMin: number; etaSource: 'route' }>) => void; // 길찾기 결과로 갱신 (SFR-129)
  'request.approved':      (e: Envelope<{ transportId: string; request: AppHospitalRequest; firstApproval: boolean; afterReconnect: boolean }>) => void; // 첫 승인·연결 복구 승인 = 진동·소리·푸시
  'request.rejected':      (e: Envelope<{ transportId: string; hospitalRequestId: number; hospitalName: string; reason: string }>) => void;
  'request.cancelled':     (e: Envelope<{ transportId: string; hospitalRequestId: number; hospitalName: string; reason: string; wasConfirmed: boolean }>) => void; // 승인 취소 · 푸시 (SFR-128)
  'request.expired':       (e: Envelope<{ transportId: string; roundNo: number; anyApproved: boolean }>) => void; // 2분 · 팀원 모두 진동·소리·푸시 (SFR-130)
  'approval.expiring':     (e: Envelope<{ transportId: string; releaseAt: string }>) => void;                   // 4분, 미확정 유효 승인 1곳 이상일 때만 · 푸시
  'approval.expired':      (e: Envelope<{ transportId: string }>) => void;                                      // 5분 · 푸시
  'transport.status':      (e: Envelope<{ transportId: string; status: TransportStatus; event: string; reason: string | null; byName: string | null }>) => void; // 모든 상태 변경 (예비 전환 사유·취소 사유 포함)
  'transport.confirmed':   (e: Envelope<{ transportId: string; hospitalId: number; hospitalName: string; byName: string; etaMin: number; memo: string | null; navDeviceId: string | null }>) => void; // "김도윤 님이 B병원을 선택했어요" (SFR-160)
  'transport.nav_device':  (e: Envelope<{ transportId: string; navDeviceId: string; byName: string }>) => void;          // 경로 안내 담당 단말 지정·변경 (SFR-132)
  'transport.phone_target':(e: Envelope<{ transportId: string; hospitalId: number; hospitalName: string }>) => void;     // 전화 확인 대상 병원 (부록 A13·A16)
  'transport.eta':         (e: Envelope<{ transportId: string; etaMin: number }>) => void;                     // 이동 중 1분마다
  'assessment.sent':       (e: Envelope<{ transportId: string; assessmentSeq: number; changedFields: string[]; byName: string }>) => void;
  'hospital.extra_memo':   (e: Envelope<{ transportId: string; hospitalName: string; memo: string }>) => void;   // 푸시 (SFR-140)
  'transport.arrive_requested': (e: Envelope<{ transportId: string; hospitalName: string }>) => void;          // 위치 없는 건에 병원 '도착 확인' · 푸시 (SFR-144)
  'transport.arrived':     (e: Envelope<{ transportId: string; method: 'button' | 'menu' | 'hospital' | 'finish_previous'; durationSec: number }>) => void;
  'transport.unacceptable':(e: Envelope<{ transportId: string; hospitalName: string; reason: string }>) => void;  // 푸시 (SFR-158)
}

// =====================================================================
// B. 서버 → 병원 웹   (/hospital, 방: hospital:{id} = 등록 PC 전체, hospital:{id}:on = 알림 켠 PC만)
//    병원 쪽은 재연결 때 '다시 받기' 없이 항상 전체를 새로 받는다 (GET /hw/requests, /hw/incoming)
// =====================================================================
export interface HospitalServerEvents {
  /** hospital:{id}:on 방에만. 5초 안 ack. 1대라도 ack하면 '전달'. ack 안 한 PC는 알림이 꺼짐 처리 */
  /** label = 고정 문구('새 이송 요청')만. 증상·나이·측정값은 넣지 않음 (SER-014) */
  'request.new':          (e: Envelope<{ requestId: number; label: string; respondUntil: string }>, ack: (r: { received: true }) => void) => void;
  'request.changed':      (e: Envelope<{ requestId: number; status: HreqStatus; closeReason: CloseReason | null; byName: string | null; pcName: string | null }>) => void; // 다른 PC 응답·만료·닫힘·승인 취소·추가 메모 동기화 (SFR-153, SFR-125)
  'request.updated':      (e: Envelope<{ requestId: number; changedFields: string[] }>) => void;          // 대기·승인 중 환자 정보 변경 (SFR-105) — 값은 GET
  'request.eta':          (e: Envelope<{ requestId: number; etaMin: number; etaSource: 'route' }>) => void;
  'incoming.added':       (e: Envelope<{ requestId: number; label: string; etaMin: number; hasLocation: boolean }>) => void;
  'incoming.updated':     (e: Envelope<{ requestId: number; etaMin?: number; changedFields?: string[] }>) => void;
  'incoming.near':        (e: Envelope<{ requestId: number }>) => void;                                      // 200m 안 → '도착 확인' 활성
  'incoming.arrived':     (e: Envelope<{ requestId: number; arrivedAt: string; method: string }>) => void;
  'incoming.removed':     (e: Envelope<{ requestId: number; reason: 'cancelled' | 'dest_changed' | 'approval_cancelled' }>) => void;
  'hospital.pause_changed':(e: Envelope<{ paused: boolean; byPcName: string; pausedAt: string | null }>) => void; // 병원 전체 PC (SFR-139)
  'hospital.pause_reminder':(e: Envelope<{ pausedAt: string }>) => void;                                     // 중지 2시간째
  'hospital.alarm_off':   (e: Envelope<{ reason: 'no_ack' | 'shift_ended' }>) => void;                       // 이 PC는 요청 대상에서 빠짐
  'pc.revoked':           (e: Envelope<{ reason: 'key_revoked' | 'key_expired' | 'pc_released' | 'account_suspended' }>) => void;
}

// =====================================================================
// C. 서버 → 관리자 웹   (/admin, 방 admin)
// =====================================================================
export interface AdminServerEvents {
  'admin.notification': (e: Envelope<{ id: number; kind: 'collect_fail' | 'signup' | 'pc_change' | 'key_expiring' | 'odd_pc'; text: string; occurrences: number; unread: number }>) => void;
}

// =====================================================================
// D. 클라이언트 → 서버 (이것 말고는 전부 REST)
// =====================================================================
export interface AppClientEvents {
  /** 연결·재연결 직후 1번. 그동안 받은 실시간 이벤트는 모아 뒀다가 ack 뒤에 처리 */
  'sync': (req: { lastSeq: number | null }, ack: (r: { replayed: number; snapshotRequired: boolean; latestSeq: number; serverNow: string }) => void) => void;
  'app.visibility': (req: { visible: boolean }) => void;
}
export interface HospitalClientEvents {
  /** 탭을 유지한 채 다시 붙었을 때 알림 켜기 자동 복구 (새로고침했으면 거부 → 다시 누르기) */
  'alarm.resume': (req: { shiftId: number }, ack: (r: { ok: boolean }) => void) => void;
}
