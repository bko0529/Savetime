/**
 * 가입 신청 입력 (SFR-017). 규칙은 서버(server/src/modules/auth/signup.ts)와 같게 맞췄다.
 * 소방서 코드가 맞는지 · 아이디가 겹치는지는 서버만 알 수 있어서 서버 문구를 그대로 보여 준다.
 *
 * 환자 정보가 아니라 대원 본인 정보라 서버로 보낸다. 공무원증 사진은 서버가 암호화해 두고 승인·반려 즉시 지운다.
 */
import { z } from 'zod';

export const RANKS = ['소방사', '소방교', '소방장', '소방위', '소방경'] as const;

export type Photo = { uri: string; name: string; type: string; size?: number };

export type SignupForm = {
  agencyCode: string;
  safetyCenter: string;
  name: string;
  rank: string;
  employeeNo: string;
  loginId: string;
  password: string;
  password2: string;
  photo: Photo | null;
  photoConsent: boolean;
};

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** 8자 이상, 영문+숫자 (SER-006) */
export const passwordOk = (pw: string) => pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);

const profile = z.object({
  agencyCode: z.string().trim().min(1, '소속 소방서 코드를 적어 주세요'),
  safetyCenter: z.string().trim().min(1, '이름 · 소속 안전센터 · 사번을 모두 적어 주세요'),
  name: z.string().trim().min(1, '이름 · 소속 안전센터 · 사번을 모두 적어 주세요'),
  employeeNo: z.string().trim().min(1, '이름 · 소속 안전센터 · 사번을 모두 적어 주세요'),
});
const account = z.object({
  loginId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9._-]{4,40}$/, '아이디는 영문 · 숫자 · . _ - 로 4~40자예요'),
  password: z.string().refine(passwordOk, '비밀번호는 8자 이상, 영문과 숫자를 섞어 주세요'),
});

/** 첫 번째 문제의 문구, 없으면 null. reapply = 반려 후 다시 신청 (아이디·비밀번호 없음) */
export function signupError(f: SignupForm, reapply: boolean): string | null {
  const p = profile.safeParse(f);
  if (!p.success) return p.error.issues[0]!.message;
  if (!reapply) {
    const a = account.safeParse(f);
    if (!a.success) return a.error.issues[0]!.message;
    if (f.password !== f.password2) return '비밀번호 확인이 달라요';
  }
  if (!f.photo) return '공무원증 사진을 올려 주세요';
  if (f.photo.size && f.photo.size > MAX_PHOTO_BYTES) return '사진은 5MB 이하만 올릴 수 있어요';
  if (!f.photoConsent) return '공무원증 사진 수집 · 이용에 동의해야 신청할 수 있어요';
  return null;
}

/**
 * 서버로 보낼 multipart. React Native 의 FormData 는 파일을 {uri, name, type} 로 넣는다
 * (파일 내용은 fetch 가 uri 에서 직접 읽어 보낸다).
 */
export function toSignupFormData(f: SignupForm, withAccount: boolean): FormData {
  const form = new FormData();
  form.append('agencyCode', f.agencyCode.trim().toUpperCase());
  form.append('name', f.name.trim());
  form.append('rank', f.rank);
  form.append('safetyCenter', f.safetyCenter.trim());
  form.append('employeeNo', f.employeeNo.trim());
  form.append('photoConsent', String(f.photoConsent));
  if (f.photo) form.append('photo', f.photo as unknown as Blob);
  if (withAccount) {
    form.append('loginId', f.loginId.trim());
    form.append('password', f.password);
  }
  return form;
}
