// 관리자 OTP (SFR-152). 휴대폰 OTP 앱(Google Authenticator 등)과 같은 30초짜리 6자리 코드 (TOTP)
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { generateSecret, generateURI, verify } from 'otplib';

const ISSUER = '세이브타임';
// 휴대폰 시계가 조금 틀려도 되도록 앞뒤 30초(코드 1개)까지 받아 준다
const TOLERANCE_SECONDS = 30;
// 같은 코드를 두 번 쓰지 못하게 한다 (화면을 훔쳐본 사람이 바로 다시 쓰는 것 방지). 허용 범위보다 길게 기억
const USED_CODE_SECONDS = 120;

export async function newOtpSecret(): Promise<string> {
  return generateSecret();
}

export function otpauthUrl(loginId: string, secret: string): string {
  return generateURI({ issuer: ISSUER, label: loginId, secret });
}

// 시간 판정은 DB 시각 기준 (규칙 6). 서버마다 시계가 달라도 같은 결과가 나온다
export async function verifyOtp(
  deps: { pool: pg.Pool | pg.PoolClient; redis: Redis },
  { adminKey, secret, code }: { adminKey: string; secret: string; code: string },
): Promise<boolean> {
  const { rows } = await deps.pool.query<{ epoch: number }>(
    'SELECT floor(extract(epoch FROM now()))::bigint AS epoch',
  );
  const result = await verify({
    secret,
    token: code,
    epoch: Number(rows[0].epoch),
    epochTolerance: TOLERANCE_SECONDS,
  });
  if (!result.valid) return false;

  // 한 번 쓴 코드는 다시 못 쓴다. SET NX 는 처음 한 번만 성공한다 (서버 2대여도 Redis 하나로 판정)
  const fresh = await deps.redis.set(
    `admin:otp-used:${adminKey}:${code}`,
    '1',
    'EX',
    USED_CODE_SECONDS,
    'NX',
  );
  return fresh === 'OK';
}
