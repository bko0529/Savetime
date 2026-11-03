// 병원 웹 API 테스트용: 임시 DB + 실제 Redis + 병원·라이선스 키
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import type pg from 'pg';
import {
  hashLicenseKey,
  licenseKeyPrefix,
  newLicenseKey,
} from '../modules/hospital-web/licenseKey.js';
import type { HospitalWebContext } from '../modules/hospital-web/pcAuth.js';
import { hospitalNamespace } from '../modules/hospital-web/realtime.js';
import { createRealtime, type Realtime } from '../modules/realtime/io.js';
import { TEST_REDIS_URL, withSchemaPool } from './services.js';

export const WEB_ORIGIN = 'http://localhost:3000';

export async function withHospitalWeb(
  use: (ctx: HospitalWebContext, realtime: Realtime) => Promise<void>,
): Promise<void> {
  await withSchemaPool(async (pool) => {
    // 테스트 파일이 동시에 돌아도 Redis 키(실패 횟수 등)·실시간 채널이 섞이지 않게 무작위 이름을 붙인다
    const prefix = `t_${randomBytes(6).toString('hex')}`;
    const redis = new Redis(TEST_REDIS_URL, { keyPrefix: `${prefix}:` });
    const realtime = createRealtime({ redis, keyPrefix: `${prefix}:socket.io` });
    const allowedOrigins = [WEB_ORIGIN];
    try {
      const hospitalIo = hospitalNamespace(realtime.io, { pool, allowedOrigins });
      await use({ pool, redis, allowedOrigins, hospitalIo }, realtime);
    } finally {
      await realtime.close();
      redis.disconnect();
    }
  });
}

// 병원 1곳과 그 병원의 라이선스 키를 만든다. expiresIn 은 PostgreSQL interval (음수면 이미 만료)
export async function addHospitalWithKey(
  pool: pg.Pool,
  { publicId = 'H1', name = 'A병원', expiresIn = '1 year' } = {},
): Promise<{ hospitalId: string; key: string }> {
  const { rows: admins } = await pool.query<{ id: string }>(
    `INSERT INTO admin (login_id, password_hash, name) VALUES ('issuer', 'x', '발급자')
     ON CONFLICT (login_id) DO UPDATE SET name = excluded.name RETURNING id`,
  );
  const { rows: hospitals } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, account_active)
     VALUES ($1, $2, 36.8, 127.1, true) RETURNING id`,
    [publicId, name],
  );
  const key = newLicenseKey();
  await pool.query(
    `INSERT INTO license_key (hospital_id, key_hash, key_prefix, issued_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + $5::interval)`,
    [hospitals[0].id, hashLicenseKey(key), licenseKeyPrefix(key), admins[0].id, expiresIn],
  );
  return { hospitalId: hospitals[0].id, key };
}
