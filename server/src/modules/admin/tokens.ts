// 관리자 로그인 토큰 (SFR-082, SFR-152). 대원 토큰과 같은 방식이지만 typ 이 달라 서로 바꿔 쓸 수 없다.
import { errors, jwtVerify, SignJWT } from 'jose';

const ISSUER = 'savetime';
const ACCESS_TTL = '15m';

export type AdminVerifyResult =
  { ok: true; adminId: string } | { ok: false; reason: 'expired' | 'invalid' };

export function signAdminAccessToken(key: Uint8Array, adminId: string): Promise<string> {
  return new SignJWT({ typ: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(adminId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(key);
}

export async function verifyAdminAccessToken(
  key: Uint8Array,
  token: string,
): Promise<AdminVerifyResult> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
    // 대원 토큰(typ: paramedic)으로는 관리자 API 에 못 들어온다
    if (payload.typ !== 'admin' || typeof payload.sub !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, adminId: payload.sub };
  } catch (err) {
    return { ok: false, reason: err instanceof errors.JWTExpired ? 'expired' : 'invalid' };
  }
}
