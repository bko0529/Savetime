// 로그인이 필요한 API 테스트용: 임시 DB + 실제 Redis + 테스트 계정
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { hashPassword } from '../modules/auth/password.js';
import type { AuthContext, ParamedicStatus } from '../modules/auth/session.js';
import { signingKey } from '../modules/auth/tokens.js';
import { TEST_REDIS_URL, withSchemaPool } from './services.js';

export const TEST_PASSWORD = 'test-password-1234';

// 테스트 파일은 동시에 돌고 임시 DB마다 대원 ID가 1부터 시작한다. 키 앞에 무작위 이름을 붙여 서로 섞이지 않게 한다.
export async function withAuthContext(use: (ctx: AuthContext) => Promise<void>): Promise<void> {
  await withSchemaPool(async (pool) => {
    const redis = new Redis(TEST_REDIS_URL, { keyPrefix: `t_${randomBytes(6).toString('hex')}:` });
    try {
      await use({
        pool,
        redis,
        jwtKey: signingKey(randomBytes(32).toString('base64')),
        shiftHours: 14,
      });
    } finally {
      redis.disconnect();
    }
  });
}

let passwordHash: Promise<string> | undefined;

export async function addParamedic(
  pool: pg.Pool,
  { loginId = 'kim01', status = 'approved' }: { loginId?: string; status?: ParamedicStatus } = {},
): Promise<string> {
  // argon2는 일부러 느리다. 테스트마다 다시 계산하지 않는다.
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const { rows } = await pool.query<{ id: string }>(
    `WITH a AS (
       INSERT INTO agency (code, name, region) VALUES ($1, '테스트소방서', '충청남도')
       ON CONFLICT (code) DO UPDATE SET name = excluded.name RETURNING id
     )
     INSERT INTO paramedic (login_id, password_hash, name, rank, agency_id, safety_center, employee_no, status)
     SELECT $2, $3, '김도윤', '소방교', a.id, '테스트안전센터', $2, $4 FROM a
     RETURNING id`,
    ['TEST-001', loginId, await passwordHash, status],
  );
  return rows[0].id;
}
