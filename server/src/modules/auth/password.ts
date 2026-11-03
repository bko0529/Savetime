// 비밀번호는 되돌릴 수 없는 argon2id로만 저장한다 (SER-004).
import argon2 from 'argon2';

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
