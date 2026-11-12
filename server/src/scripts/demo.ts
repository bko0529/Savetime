// 시연 영상용 데이터 (S8, 배포 없이 노트북에서 시연): npm run demo -w server -- setup | reset
// - setup: 천안 근처 시연 병원 5곳(병상 값·응급실 전화·입구 좌표)·병원 라이선스 키·구급대원 계정 2명을 만든다.
//          키와 비밀번호는 이 화면에 한 번만 보이고 DB 에는 해시만 남는다. 다시 돌려도 된다(병원·대원은 그대로, 새 키·새 비밀번호)
// - reset: 찍기 직전에 돌린다. 이송 건과 그에 딸린 기록을 모두 지우고 병상 값을 '방금 수집'으로 되돌린다.
//          계정·병원 PC 등록·근무는 남기므로 다시 등록할 필요가 없다
// 지우는 일이 있어서 **이름이 _demo 로 끝나는 DB 에서만** 돈다 (개발·테스트 DB 를 실수로 지우지 않게). 운영에서는 실행 거부
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
const dbName = new URL(config.DATABASE_URL).pathname.slice(1);
if (config.NODE_ENV === 'production' || !dbName.endsWith('_demo')) {
  console.error(
    `시연 스크립트는 이름이 _demo 로 끝나는 DB 에서만 돌아요 (지금: ${dbName || '알 수 없음'}). ` +
      'DATABASE_URL 을 시연 DB 로 주세요 (docs/demo.md)',
  );
  process.exit(1);
}

// 대원 출발 위치: 천안 신부동 근처 (앱의 개발용 기본 위치와 같다)
export const DEMO_ORIGIN = { lat: 36.815, lng: 127.1139 };

// 실제 병원과 헷갈리지 않게 이름에 '(시연)'을 붙이고, 전화번호도 쓰지 않는 국번(555)으로 둔다
const HOSPITALS = [
  { id: 'DEMO-H1', name: '천안중앙병원(시연)', dLat: 0.012, dLng: 0.004, grade: 1, er: [6, 20] },
  { id: 'DEMO-H2', name: '단국의료원(시연)', dLat: 0.02, dLng: 0.03, grade: 1, er: [2, 18] },
  { id: 'DEMO-H3', name: '신부종합병원(시연)', dLat: -0.01, dLng: 0.015, grade: 2, er: [4, 12] },
  { id: 'DEMO-H4', name: '쌍용병원(시연)', dLat: -0.02, dLng: -0.025, grade: 2, er: [0, 10] },
  { id: 'DEMO-H5', name: '성정연합의원(시연)', dLat: 0.005, dLng: -0.012, grade: 3, er: [3, 6] },
] as const;

const PARAMEDICS = [
  { loginId: 'demo-kim', name: '김구조', rank: '소방교' },
  { loginId: 'demo-lee', name: '이구급', rank: '소방사' },
] as const;

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

async function setup() {
  const { rows: admins } = await pool.query<{ id: string }>(
    `INSERT INTO admin (login_id, password_hash, name) VALUES ('demo-issuer', $1, '시연용 발급자')
     ON CONFLICT (login_id) DO UPDATE SET name = excluded.name RETURNING id`,
    [await hashPassword(randomBytes(24).toString('base64url'))],
  );
  const lines: string[] = [
    '',
    '[병원] 병원 웹에서 PC 등록할 때 쓰는 라이선스 키 (병원마다 PC 3대까지)',
  ];
  for (const [i, h] of HOSPITALS.entries()) {
    const lat = DEMO_ORIGIN.lat + h.dLat;
    const lng = DEMO_ORIGIN.lng + h.dLng;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO hospital (public_id, name, address, lat, lng, er_phone, main_phone,
                             entrance_lat, entrance_lng, account_active, grade)
       VALUES ($1, $2, '충청남도 천안시 동남구 (시연)', $3, $4, $5, $5, $3, $4, true, $6)
       ON CONFLICT (public_id) DO UPDATE
         SET name = excluded.name, lat = excluded.lat, lng = excluded.lng, er_phone = excluded.er_phone,
             entrance_lat = excluded.entrance_lat, entrance_lng = excluded.entrance_lng,
             account_active = true, requests_paused = false, grade = excluded.grade
       RETURNING id`,
      [h.id, h.name, lat, lng, `041-555-01${String(i + 1).padStart(2, '0')}`, h.grade],
    );
    const hospitalId = rows[0].id;
    await refreshBeds(hospitalId, h.er);
    const key = newLicenseKey();
    await pool.query(
      `INSERT INTO license_key (hospital_id, key_hash, key_prefix, issued_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '90 days')`,
      [hospitalId, hashLicenseKey(key), licenseKeyPrefix(key), admins[0].id],
    );
    lines.push(`  ${h.name.padEnd(12)} ${key}`);
  }

  // 비밀번호는 DEMO_PASSWORD 를 주면 그 값(두 계정 같음), 없으면 무작위로 만들어 이 화면에만 보여 준다
  lines.push('', '[구급대원 앱] 로그인 (둘이 앱에서 팀을 맺는다)');
  const { rows: agency } = await pool.query<{ id: string }>(
    `INSERT INTO agency (code, name, region) VALUES ('DEMO-AG', '천안동남소방서(시연)', '충청남도')
     ON CONFLICT (code) DO UPDATE SET name = excluded.name RETURNING id`,
  );
  for (const p of PARAMEDICS) {
    const password = process.env.DEMO_PASSWORD || `${randomBytes(6).toString('base64url')}7a`;
    await pool.query(
      `INSERT INTO paramedic (login_id, password_hash, name, rank, agency_id, safety_center, employee_no, status)
       VALUES ($1, $2, $3, $4, $5, '신부119안전센터(시연)', $1, 'approved')
       ON CONFLICT (login_id) DO UPDATE
         SET password_hash = excluded.password_hash, status = 'approved', must_change_pw = false,
             failed_count = 0, locked_until = NULL, session_version = paramedic.session_version + 1`,
      [p.loginId, await hashPassword(password), p.name, p.rank, agency[0].id],
    );
    lines.push(`  ${p.name} (${p.rank})  아이디 ${p.loginId}  비밀번호 ${password}`);
  }
  // 이 화면에만 보이는 값이다. 파일·로그로 남기지 않는다
  console.log(`시연 데이터 준비 완료 (DB ${dbName})${lines.join('\n')}`);
  console.log(`\n대원 출발 위치(앱 위치 흉내): 위도 ${DEMO_ORIGIN.lat}, 경도 ${DEMO_ORIGIN.lng}`);
}

// 병상 값을 '방금 수집한 것'으로. 10분이 지나면 앱에 '갱신 지연'이 떠서 찍기 직전 reset 이 다시 맞춘다
async function refreshBeds(hospitalId: string, [erAvail, erTotal]: readonly [number, number]) {
  await pool.query(
    `INSERT INTO bed_current (hospital_id, er_avail, er_total, icu_avail, icu_total, or_avail, or_total,
                              source_time, collected_at)
     VALUES ($1, $2, $3, 2, 8, 1, 4, now(), now())
     ON CONFLICT (hospital_id) DO UPDATE
       SET er_avail = excluded.er_avail, er_total = excluded.er_total, source_time = now(),
           collected_at = now(), excluded = false`,
    [hospitalId, erAvail, erTotal],
  );
}

async function reset() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 이송 건을 가리키는 기록(회차·병원 요청·평가·위치·전화 확인 등)까지 같이 비운다.
    // 통계·이벤트·팀 작성 중 정보도 지워 첫 장면이 깨끗하게 시작하게 한다. 계정·병원·PC·근무는 그대로
    await client.query(
      'TRUNCATE transport, event_log, team_draft, transport_stat, rejection_record, anonymous_route CASCADE',
    );
    await client.query(
      `UPDATE hospital SET requests_paused = false, paused_at = NULL WHERE public_id LIKE 'DEMO-%'`,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ id: string; public_id: string }>(
    "SELECT id, public_id FROM hospital WHERE public_id LIKE 'DEMO-%'",
  );
  for (const r of rows) {
    const h = HOSPITALS.find((x) => x.id === r.public_id);
    if (h) await refreshBeds(r.id, h.er);
  }
  const { rows: shifts } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM hospital_shift s JOIN hospital_pc p ON p.id = s.pc_id
       JOIN hospital h ON h.id = p.hospital_id
      WHERE h.public_id LIKE 'DEMO-%' AND p.released_at IS NULL
        AND s.alarm_on_at IS NOT NULL AND s.ended_at IS NULL`,
  );
  console.log(
    `시연 초기화 완료: 이송 기록 비움, 병상 값 새로 고침 (DB ${dbName})\n` +
      `  요청을 받을 수 있는 병원 PC(근무 중·알림 켬): ${shifts[0].n}대` +
      (shifts[0].n === 0 ? '  ← 병원 웹에서 근무 시작·알림 켜기를 해야 요청이 가요' : ''),
  );
}

try {
  const command = process.argv[2];
  if (command === 'setup') await setup();
  else if (command === 'reset') await reset();
  else {
    console.error('사용법: npm run demo -w server -- setup | reset');
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
