// 병원 라이선스 키 (SFR-123, COR-012). 관리자가 병원마다 발급하고, 병원 PC 등록 때 한 번 입력한다.
// DB에는 해시만 둔다. 키가 새도 DB만으로는 원래 키를 알 수 없다.
import { createHash, randomInt } from 'node:crypto';

// 손으로 옮겨 적어도 헷갈리지 않게 0·O·1·I·L 을 뺀 글자만 쓴다
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 5;
const GROUP_SIZE = 4;

// 예: K7QM-2XRA-PZ4N-8TCE-W3HV (약 98비트, 추측 불가)
export function newLicenseKey(): string {
  const groups = Array.from({ length: GROUPS }, () =>
    Array.from({ length: GROUP_SIZE }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  );
  return groups.join('-');
}

// 입력할 때 넣은 띄어쓰기·하이픈·소문자는 무시한다
export function normalizeLicenseKey(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

// 무작위 키라서 비밀번호처럼 느린 해시가 필요 없다 (갱신 토큰과 같은 이유)
export function hashLicenseKey(input: string): string {
  return createHash('sha256').update(normalizeLicenseKey(input)).digest('hex');
}

// 관리자 화면에는 앞 4자리만 보여 준다
export function licenseKeyPrefix(key: string): string {
  return normalizeLicenseKey(key).slice(0, 4);
}
