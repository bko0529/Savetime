// 로그인 토큰 2종 (SER-016, 기술정의서 로그인 토큰)
// - 접근 토큰: 15분짜리 JWT. 매 요청에 붙이고, 서버는 서명만 보고 누구인지 안다.
// - 갱신 토큰: 무작위 문자열. DB에 해시만 저장해 두고, 서버가 지우면 바로 못 쓴다.
import { createHash, randomBytes } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';

const ISSUER = 'savetime';
const ACCESS_TTL = '15m';

export interface AccessClaims {
  paramedicId: string;
  sessionVersion: number;
}

export type VerifyResult =
  { ok: true; claims: AccessClaims } | { ok: false; reason: 'expired' | 'invalid' };

export function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function signAccessToken(key: Uint8Array, claims: AccessClaims): Promise<string> {
  return new SignJWT({ sv: claims.sessionVersion, typ: 'paramedic' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.paramedicId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(key);
}

export async function verifyAccessToken(key: Uint8Array, token: string): Promise<VerifyResult> {
  try {
    // 알고리즘을 고정한다. 토큰이 정한 알고리즘을 그대로 믿으면 서명 없는 토큰이 통과할 수 있다.
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
    if (
      payload.typ !== 'paramedic' ||
      typeof payload.sub !== 'string' ||
      typeof payload.sv !== 'number'
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, claims: { paramedicId: payload.sub, sessionVersion: payload.sv } };
  } catch (err) {
    return { ok: false, reason: err instanceof errors.JWTExpired ? 'expired' : 'invalid' };
  }
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

// 갱신 토큰은 추측할 수 없는 무작위 값이라 빠른 해시로 충분하다. DB가 새도 원래 토큰은 알 수 없다.
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
