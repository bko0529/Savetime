// 부하 테스트용 '요청 받는 병원' 만들기: npm run perf:dispatch -w server -- [병원 수, 기본 10]
// transports.yml(PER-006·007)에서 대원이 이송을 요청하면 요청이 실제로 가는 병원이 있어야 한다.
// 요청 대상 = 반경 안 + 계정 활성 + 요청 중지 아님 + '알림 켠 근무'가 있는 PC (requestTargets.ts).
// 그래서 병원마다 PC 1대와 진행 중 근무를 만들고, 쿠키와 근무 id 를 perf/.dispatch-pcs.csv 에 쓴다.
// perf/hospital-bot.mjs 가 이 파일로 붙어 알림을 켜고(alarm.resume) 요청을 받아 승인한다.
// - 병원은 대원 출발 위치(천안, 36.815·127.1139) 반경 10km 안에 고르게 둔다
// - 다시 돌리면 앞서 만든 부하 테스트 PC 는 해제하고 근무를 끝낸 뒤 새로 만든다
// - 운영 DB 에서는 실행하지 않는다
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
  console.error('운영 환경에서는 부하 테스트용 병원을 만들 수 없어요 (NODE_ENV=development 확인)');
  process.exit(1);
}

const count = Number(process.argv[2] ?? 10);
if (!Number.isInteger(count) || count < 1 || count > 100) {
  console.error('병원 수는 1~100 사이로 주세요');
  process.exit(1);
}

// 대원 출발 위치 (processor.mjs 의 START 와 같다)
const START = { lat: 36.815, lng: 127.1139 };
const PREFIX = 'PERF-D';
const out = fileURLToPath(new URL('../../../perf/.dispatch-pcs.csv', import.meta.url));

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  const { rows: admins } = await pool.query<{ id: string }>(
    `INSERT INTO admin (login_id, password_hash, name) VALUES ('dev-issuer', $1, '개발용 발급자')
     ON CONFLICT (login_id) DO UPDATE SET name = excluded.name RETURNING id`,
    [await hashPassword(randomBytes(24).toString('base64url'))],
  );
  // 앞서 만든 PC 의 근무를 끝내고 PC 를 해제한다 (쿠키 파일과 DB 를 늘 맞춘다)
  await pool.query(
    `UPDATE hospital_shift SET ended_at = now(), alarm_on_at = NULL
      WHERE ended_at IS NULL
        AND pc_id IN (SELECT p.id FROM hospital_pc p JOIN hospital h ON h.id = p.hospital_id
                       WHERE h.public_id LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(
    `UPDATE hospital_pc SET released_at = now()
      WHERE released_at IS NULL
        AND hospital_id IN (SELECT id FROM hospital WHERE public_id LIKE $1)`,
    [`${PREFIX}%`],
  );

  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const publicId = `${PREFIX}${String(i + 1).padStart(3, '0')}`;
    // 출발 위치를 중심으로 반지름 약 1~6km 원 위에 고르게 놓는다 (반경 10km 요청에 모두 들어온다)
    const angle = (2 * Math.PI * i) / count;
    const km = 1 + (i % 6);
    const lat = START.lat + (km / 111) * Math.sin(angle);
    const lng = START.lng + (km / (111 * Math.cos((START.lat * Math.PI) / 180))) * Math.cos(angle);
    const { rows: hospitals } = await pool.query<{ id: string }>(
      `INSERT INTO hospital (public_id, name, lat, lng, account_active, requests_paused)
       VALUES ($1, $2, $3, $4, true, false)
       ON CONFLICT (public_id) DO UPDATE
         SET lat = excluded.lat, lng = excluded.lng, account_active = true, requests_paused = false
       RETURNING id`,
      [publicId, `부하테스트 수용병원 ${i + 1}`, lat.toFixed(6), lng.toFixed(6)],
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
    const token = newPcToken();
    const { rows: pcs } = await pool.query<{ id: string }>(
      'INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id',
      [hospitalId, '부하 PC', hashPcToken(token)],
    );
    // 근무만 시작해 둔다. 알림은 봇이 붙을 때 alarm.resume 으로 켠다 (붙지 않은 PC 에 요청이 가지 않게)
    const { rows: shifts } = await pool.query<{ id: string }>(
      `INSERT INTO hospital_shift (pc_id, staff_name) VALUES ($1, '부하 근무자') RETURNING id`,
      [pcs[0].id],
    );
    rows.push(`st_pc=${token},${shifts[0].id}`);
  }

  // 쿠키는 등록 PC 인증 값이라 git 에 올리지 않는다 (perf/.gitignore)
  writeFileSync(out, `cookie,shiftId\n${rows.join('\n')}\n`);
  console.log(`부하 테스트용 수용 병원 ${count}곳(PC·근무 1개씩) 준비 완료\n  ${out}`);
} finally {
  await pool.end();
}
