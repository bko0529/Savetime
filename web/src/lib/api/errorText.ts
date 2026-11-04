import { ApiError, NETWORK_ERROR } from './client';

// 서버 오류 코드 → 병원 직원이 바로 알아듣는 문구 (4_API명세.md 오류 코드표). 없는 코드는 서버 문구를 쓴다.
const ERROR_TEXT: Record<string, string> = {
  INVALID_LICENSE: '라이선스 키가 맞지 않아요. 다시 확인해 주세요.',
  LICENSE_EXPIRED: '라이선스 키 기간이 끝났어요. 관리자에게 새 키를 요청해 주세요.',
  TOO_MANY_ATTEMPTS: '키를 5번 틀려서 이 PC에서 10분 동안 입력할 수 없어요.',
  INVALID_CREDENTIALS: '아이디 또는 비밀번호가 맞지 않아요.',
  INVALID_OTP: 'OTP 코드가 맞지 않아요. 앱에 지금 떠 있는 6자리를 입력해 주세요.',
  ACCOUNT_LOCKED: '5번 틀려서 10분 동안 로그인할 수 없어요.',
  ACCOUNT_SUSPENDED: '병원 계정이 정지됐어요. 관리자에게 문의하세요.',
  ACCOUNT_EXISTS: '이미 병원 계정이 있어요.',
  ORIGIN_NOT_ALLOWED: '허용되지 않은 주소에서 접속했어요. 병원 웹 주소를 확인해 주세요.',
  [NETWORK_ERROR]: '서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.',
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return ERROR_TEXT[error.code] ?? error.message;
  return '잠시 후 다시 시도해 주세요.';
}
