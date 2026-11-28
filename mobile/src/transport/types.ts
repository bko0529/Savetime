/**
 * 이송 상태 타입과 화면 문구.
 * 상태 타입은 서버의 상태 전이표(server/src/domain/stateMachine.ts)에서 가져온다 (타입만, 실행 코드는 안 가져옴).
 * 규칙 4: 상태를 바꾸는 판정은 서버만 한다. 앱은 서버가 준 상태를 보여 주기만 한다.
 */
export type {
  CloseReason,
  DestChangeReason,
  FallbackReason,
  HreqStatus,
  PhoneProceedReason,
  TransportStatus,
} from '../../../server/src/domain/stateMachine';
import type {
  CloseReason,
  HreqStatus,
  TransportStatus,
} from '../../../server/src/domain/stateMachine';

export const DONE: TransportStatus[] = ['arrived', 'cancelled'];
export const isActive = (s: TransportStatus | null) => !!s && !DONE.includes(s);

export const STATUS_STEP_LABEL: Record<TransportStatus, string> = {
  requesting: '병원에 요청',
  fallback: '예비 추천',
  phone_check: '전화 확인 시작',
  moving: '이동 시작',
  arrived: '도착 처리',
  cancelled: '이송 취소',
};

export const REJECT_TEXT: Partial<Record<string, string>> = {
  er_bed: '응급실 병상 부족',
  or_room: '수술실 부족',
  ward: '입원 병상 부족',
  icu: '중환자실 부족',
  no_specialist: '전문의 부재',
  equipment: '장비 문제',
  etc: '기타',
  paused: '요청 잠시 중지',
};

export const REASON_LABEL: Record<string, string> = {
  all_rejected: '모든 병원이 거절했어요',
  expired_no_approval: '2분 동안 승인한 병원이 없어요',
  none_delivered: '요청이 병원에 전달되지 않았어요',
  approvals_cancelled: '병원들이 승인을 취소했어요',
  approval_window: '요청 후 5분이 지나 요청이 닫혔어요',
  no_target: '조건에 맞는 병원이 없어요',
  offline: '통신이 끊겨 요청을 보내지 못했어요',
  phone_rejected_last: '전화한 병원이 모두 거절했어요',
  phone_dismissed: '전화 결과를 고르지 않았어요',
  no_answer: '연결 실패',
  busy: '통화 중',
  urgent: '환자 급함',
  etc: '기타',
  user: '대원이 취소',
  button: '도착 버튼',
  patient_change: '환자 상태 변화',
  road: '도로 사정',
  hospital: '병원 사정',
};

export const HREQ_LABEL: Record<HreqStatus, string> = {
  waiting: '대기',
  delivery_failed: '전달 실패',
  approved: '승인',
  rejected: '거절',
  expired: '응답 없음',
  closed: '닫힘',
  confirmed: '확정',
  arrived: '도착',
  unacceptable: '수용 불가',
};

export const CLOSE_LABEL: Record<CloseReason, string> = {
  other_hospital: '다른 병원 확정',
  fallback: '요청 종료',
  cancelled: '취소됨',
  expired_approval: '승인 만료(5분)',
  approval_cancelled: '승인 취소',
  dest_changed: '목적지 변경',
};
