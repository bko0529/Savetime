// 부하 테스트용 병원 PC 만들기: npm run perf:pcs -w server -- [PC 수, 기본 200]
// Artillery 시나리오(perf/)가 가상 병원 PC 마다 다른 쿠키로 붙도록 PC 를 미리 등록하고 쿠키를 perf/.pcs.csv 에 쓴다.
// 실제 등록 API 는 키 5번 실패 잠금·PC 3대 제한이 있어 부하 준비에는 쓰지 않고 DB 에 바로 넣는다. 운영 DB 에서는 실행하지 않는다.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { hashPassword } from '../modules/auth/password.js';
import {
  hashLicenseKey,
  licenseKeyPrefix,
  newLicenseKey,
} from '../modules/hospital-web/licenseKey.js';
import { hashPcToken, newPcToken } from '../modules/hospital-web/pcAuth.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('운영 환경에서는 부하 테스트용 PC 를 만들 수 없어요 (NODE_ENV=development 확인)');
  process.exit(1);
}

const count = Number(process.argv[2] ?? 200);
if (!Number.isInteger(count) || count < 1 || count > 6000) {
  console.error('PC 수는 1~6000 사이로 주세요');
  process.exit(1);
}
// 병원당 PC 는 3대까지 (SFR-147). 실제 전국 규모처럼 병원 수 = PC 수 / 3
const PCS_PER_HOSPITAL = 3;
const out = fileURLToPath(new URL('../../../perf/.pcs.csv', import.meta.url));

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  const { rows: admins } = await pool.query<{ id: string }>(
    `INSERT INTO admin (login_id, password_hash, name) VALUES ('dev-issuer', $1, '개발용 발급자')
     ON CONFLICT (login_id) DO UPDATE SET name = excluded.name RETURNING id`,
    [await hashPassword(randomBytes(24).toString('base64url'))],
  );
  // 다시 돌리면 앞서 만든 부하 테스트 PC 는 해제한다 (쿠키 파일과 DB 를 늘 맞춘다)
  await pool.query(
    `UPDATE hospital_pc SET released_at = now()
      WHERE released_at IS NULL
        AND hospital_id IN (SELECT id FROM hospital WHERE public_id LIKE 'PERF-%')`,
  );

  const cookies: string[] = [];
  for (let h = 0; h * PCS_PER_HOSPITAL < count; h += 1) {
    const publicId = `PERF-H${String(h + 1).padStart(4, '0')}`;
    const { rows: hospitals } = await pool.query<{ id: string }>(
      `INSERT INTO hospital (public_id, name, lat, lng, account_active)
       VALUES ($1, $2, 36.8, 127.1, true)
       ON CONFLICT (public_id) DO UPDATE SET account_active = true RETURNING id`,
      [publicId, `부하테스트 ${publicId}`],
    );
    const hospitalId = hospitals[0].id;
    // 유효한 키가 없으면 PC 가 LICENSE_EXPIRED 로 막힌다 (SFR-146). 키 값은 쓰지 않으니 버린다
    const key = newLicenseKey();
    await pool.query(
      `INSERT INTO license_key (hospital_id, key_hash, key_prefix, issued_by, expires_at)
       SELECT $1, $2, $3, $4, now() + interval '30 days'
        WHERE NOT EXISTS (SELECT 1 FROM license_key
                           WHERE hospital_id = $1 AND revoked_at IS NULL AND expires_at > now())`,
      [hospitalId, hashLicenseKey(key), licenseKeyPrefix(key), admins[0].id],
    );
    for (let p = 0; p < PCS_PER_HOSPITAL && cookies.length < count; p += 1) {
      const token = newPcToken();
      await pool.query(
        'INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, $2, $3)',
        [hospitalId, `부하 PC ${p + 1}`, hashPcToken(token)],
      );
      cookies.push(`st_pc=${token}`);
    }
  }

  // 쿠키는 등록 PC 인증 값이라 git 에 올리지 않는다 (.gitignore)
  writeFileSync(out, `cookie\n${cookies.join('\n')}\n`);
  console.log(
    `부하 테스트용 PC ${cookies.length}대 준비 완료 (병원 ${Math.ceil(count / PCS_PER_HOSPITAL)}곳)\n  쿠키 파일: ${out}`,
  );
} finally {
  await pool.end();
}
