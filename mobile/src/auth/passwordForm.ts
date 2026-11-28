import { passwordOk } from './signupForm';

/** SFR-021: 비밀번호 바꾸기 입력 검사 (지금 비밀번호가 맞는지는 서버가 본다). 통과하면 null */
export function newPasswordError(f: {
  current: string;
  next: string;
  confirm: string;
}): string | null {
  if (!f.current) return '지금 비밀번호를 넣어 주세요';
  if (!passwordOk(f.next)) return '새 비밀번호는 8자 이상, 영문과 숫자를 섞어 주세요';
  if (f.next === f.current) return '지금 비밀번호와 다른 비밀번호를 정해 주세요';
  if (f.next !== f.confirm) return '새 비밀번호 두 칸이 서로 달라요';
  return null;
}
