// 비밀번호는 되돌릴 수 없는 argon2id로만 저장한다 (SER-004).
import argon2 from 'argon2';
import { z } from 'zod';

// 새 비밀번호 규칙 (SER-006): 8자 이상, 영문과 숫자를 모두 넣는다. 가입·비밀번호 변경이 같이 쓴다.
// 로그인은 이 규칙을 보지 않는다 (규칙이 생기기 전에 만든 비밀번호로도 들어올 수 있게)
export const PASSWORD_MIN = 8;
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN)
  .max(200)
  .regex(/[A-Za-z]/, '영문을 1자 이상 넣어 주세요')
  .regex(/[0-9]/, '숫자를 1자 이상 넣어 주세요');

export function meetsPasswordRule(password: string): boolean {
  return newPasswordSchema.safeParse(password).success;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

// 없는 아이디도 같은 시간만큼 계산한다. 바로 답하면 응답 속도로 '있는 아이디'를 알아낼 수 있다.
let dummyHash: Promise<string> | undefined;

export async function verifyPassword(hash: string | undefined, password: string): Promise<boolean> {
  if (hash === undefined) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await argon2.verify(await dummyHash, password);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    // 저장값이 argon2 형식이 아니면 맞는 비밀번호가 있을 수 없다
    return false;
  }
}
