// 개발용 병원 라이선스 키 만들기: npm run license:dev -- [병원 공공데이터 ID]
// 관리자 키 발급 화면(A-03)이 생기기 전까지 병원 웹 PC 등록을 시험하려고 쓴다. 운영 DB에서는 실행하지 않는다.
// 병원 ID를 주지 않으면 '개발용 병원'을 만들어 쓴다. 키는 이 화면에 한 번만 보이고 DB에는 해시만 남는다.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { hashPassword } from '../modules/auth/password.js';
import {
  hashLicenseKey,
  licenseKeyPrefix,
  newLicenseKey,
} from '../modules/hospital-web/licenseKey.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('운영 환경에서는 개발용 키를 만들 수 없어요 (NODE_ENV=development 확인)');
  process.exit(1);
}

const publicId = process.argv[2] ?? 'DEV-H1';
const key = newLicenseKey();

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  // 키에는 발급한 관리자가 꼭 있어야 한다. 로그인은 못 하는 개발용 관리자를 하나 둔다
  const { rows: admins } = await pool.query<{ id: string }>(
    `INSERT INTO admin (login_id, password_hash, name) VALUES ('dev-issuer', $1, '개발용 발급자')
     ON CONFLICT (login_id) DO UPDATE SET name = excluded.name RETURNING id`,
    [await hashPassword(randomBytes(24).toString('base64url'))],
  );
  const { rows: hospitals } = await pool.query<{ id: string; name: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, address, account_active)
     VALUES ($1, '개발용 병원', 36.815, 127.113, '충청남도 천안시', true)
     ON CONFLICT (public_id) DO UPDATE SET account_active = true RETURNING id, name`,
    [publicId],
  );
  await pool.query(
    `INSERT INTO license_key (hospital_id, key_hash, key_prefix, issued_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 year')`,
    [hospitals[0].id, hashLicenseKey(key), licenseKeyPrefix(key), admins[0].id],
  );
  console.log(
    `개발용 라이선스 키 준비 완료\n  병원: ${hospitals[0].name} (${publicId})\n  키: ${key}`,
  );
} finally {
  await pool.end();
}
