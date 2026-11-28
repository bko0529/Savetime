/**
 * 로그인 입력 검사 (zod). 서버에 보내기 전에 빈 칸만 막는다.
 * 아이디·비밀번호가 맞는지, 5번 틀려 잠겼는지는 서버가 판단한다 (SER-011) → 앱에서 횟수를 세지 않는다.
 */
import { z } from 'zod';

export const loginForm = z.object({
  loginId: z.string().trim().min(1, '아이디를 입력해 주세요'),
  password: z.string().min(1, '비밀번호를 입력해 주세요'),
});
export type LoginForm = z.infer<typeof loginForm>;

/** 첫 번째 오류 문구만 돌려준다 (없으면 null) */
export function checkLoginForm(input: { loginId: string; password: string }) {
  const r = loginForm.safeParse(input);
  return r.success
    ? { ok: true as const, value: r.data }
    : { ok: false as const, message: r.error.issues[0]?.message ?? '입력을 확인해 주세요' };
}
