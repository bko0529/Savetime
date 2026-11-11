// 부하 테스트용 대원 만들기: npm run perf:medics -w server -- [대원 수, 기본 200] [이동 중 이송 수, 기본 min(대원 수, 300)]
// Artillery 시나리오(perf/)가 가상 대원마다 다른 토큰으로 붙도록 대원·팀을 미리 만들고 접근 토큰을 파일에 쓴다.
//   perf/.medics.csv  token                           → app-connections.yml (PER-005 대원 앱 연결)
//   perf/.moving.csv  token,transportId,deviceId      → locations.yml (PER-008 위치 기록)
// - 로그인 API 는 비밀번호 확인(argon2)이 일부러 느려서 수천 명이 실제로 로그인하면 로그인 부하만 재게 된다.
//   그래서 서버 설정의 서명 키로 접근 토큰을 바로 만든다. 토큰은 15분이면 끝나니 만든 뒤 15분 안에 돌린다
// - 위치 기록용 이송 건은 '이동 중'(출발함·위치 동의)으로 바로 넣는다. 상태를 '바꾸는' 것이 아니라 처음 만드는 것이다
//   확정된 병원 요청(회차 1 + 요청 1건 confirmed)까지 만든다. 없으면 위치 저장 때 실제로 도는
//   남은 시간 저장·입구 200m 판정(navEta.ts afterLocations)이 건너뛰어져 실제보다 가볍게 잰다 (PER-008)
// - 다시 돌리면 앞서 만든 부하 테스트 대원의 팀을 끝내고 새 팀을 만든다. 남은 이동 중 건은 2시간 자동 종료가 정리한다
// - 운영 DB 에서는 실행하지 않는다
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { hashPassword } from '../modules/auth/password.js';
import { signAccessToken, signingKey } from '../modules/auth/tokens.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('운영 환경에서는 부하 테스트용 대원을 만들 수 없어요 (NODE_ENV=development 확인)');
  process.exit(1);
}
if (!config.JWT_SECRET) {
  console.error('JWT_SECRET 이 없어요. 서버와 같은 server/.env 로 실행해 주세요');
  process.exit(1);
}

const count = Number(process.argv[2] ?? 200);
const moving = Number(process.argv[3] ?? Math.min(count, 300));
if (!Number.isInteger(count) || count < 1 || count > 5000) {
  console.error('대원 수는 1~5000 사이로 주세요');
  process.exit(1);
}
if (!Number.isInteger(moving) || moving < 0 || moving > count) {
  console.error('이동 중 이송 수는 0~대원 수 사이로 주세요');
  process.exit(1);
}

const perfDir = new URL('../../../perf/', import.meta.url);
const medicsOut = fileURLToPath(new URL('.medics.csv', perfDir));
const movingOut = fileURLToPath(new URL('.moving.csv', perfDir));
const LOGIN_PREFIX = 'perf-m';

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  const key = signingKey(config.JWT_SECRET);
  const { rows: agencies } = await pool.query<{ id: string }>(
    `INSERT INTO agency (code, name, region) VALUES ('PERF-AG', '부하테스트 소방서', '충청남도')
     ON CONFLICT (code) DO UPDATE SET name = excluded.name RETURNING id`,
  );
  // 목적지 병원 1곳 (이동 중 이송 건의 확정 병원)
  const { rows: dest } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, account_active)
     VALUES ('PERF-DEST', '부하테스트 목적지', 36.8, 127.1, true)
     ON CONFLICT (public_id) DO UPDATE SET name = excluded.name RETURNING id`,
  );
  // 비밀번호는 쓰지 않는다 (토큰을 바로 만든다). 아무도 모르는 값으로 한 번만 계산
  const passwordHash = await hashPassword(randomBytes(24).toString('base64url'));

  // 앞서 만든 부하 테스트 대원의 팀을 끝낸다 (다시 돌려도 대원마다 활성 팀 1개)
  await pool.query(
    `UPDATE team_member SET left_at = now(), left_reason = 'duty_end'
      WHERE left_at IS NULL
        AND paramedic_id IN (SELECT id FROM paramedic WHERE login_id LIKE $1)`,
    [`${LOGIN_PREFIX}%`],
  );
  await pool.query(
    `UPDATE team SET ended_at = now()
      WHERE ended_at IS NULL
        AND created_by IN (SELECT id FROM paramedic WHERE login_id LIKE $1)`,
    [`${LOGIN_PREFIX}%`],
  );

  // 팀 코드는 활성 팀끼리 겹치면 안 된다. 지금 쓰는 코드를 피해 차례로 고른다
  const { rows: used } = await pool.query<{ code: string }>(
    'SELECT code FROM team WHERE ended_at IS NULL',
  );
  const taken = new Set(used.map((r) => r.code));
  let nextCode = 1000;
  const freeCode = () => {
    while (taken.has(String(nextCode))) nextCode += 1;
    if (nextCode > 9999) throw new Error('남은 팀 코드가 없어요');
    const code = String(nextCode);
    taken.add(code);
    return code;
  };

  const medics: string[] = [];
  const movingRows: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const loginId = `${LOGIN_PREFIX}${String(i).padStart(4, '0')}`;
    const { rows: p } = await pool.query<{ id: string; session_version: number }>(
      `INSERT INTO paramedic (login_id, password_hash, name, rank, agency_id, safety_center, employee_no, status)
       VALUES ($1, $2, $3, '소방사', $4, '부하테스트 안전센터', $1, 'approved')
       ON CONFLICT (login_id) DO UPDATE SET status = 'approved', must_change_pw = false
       RETURNING id, session_version`,
      [loginId, passwordHash, `부하대원${i}`, agencies[0].id],
    );
    const paramedicId = p[0].id;
    const { rows: team } = await pool.query<{ id: string }>(
      `INSERT INTO team (code, qr_token, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [freeCode(), randomBytes(12).toString('base64url'), paramedicId],
    );
    await pool.query(
      "INSERT INTO team_member (team_id, paramedic_id, role) VALUES ($1, $2, 'driver')",
      [team[0].id, paramedicId],
    );
    const token = await signAccessToken(key, {
      paramedicId,
      sessionVersion: p[0].session_version,
    });
    medics.push(token);

    if (i <= moving) {
      const transportId = randomUUID();
      const deviceId = `perf-device-${i}`;
      // 경로 안내 담당 단말은 확정 때 정해진다(SFR-132). 담당이 아니면 위치 기록이 NOT_NAV_DEVICE 로 막히므로 미리 정해 둔다
      await pool.query(
        `INSERT INTO transport (id, team_id, status, location_consent, confirmed_hospital_id,
                                confirmed_at, departed_at, nav_device_id)
         VALUES ($1, $2, 'moving', true, $3, now(), now() - interval '1 minute', $4)`,
        [transportId, team[0].id, dest[0].id, deviceId],
      );
      await pool.query(
        `WITH r AS (
           INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
           VALUES ($1, 1, 10, now() - interval '2 minutes', now(), now() + interval '3 minutes')
           RETURNING id
         )
         INSERT INTO hospital_request (round_id, hospital_id, status, eta_min, eta_source, delivered_at, responded_at)
         SELECT r.id, $2, 'confirmed', 15, 'straight', now() - interval '2 minutes', now() - interval '1 minute' FROM r`,
        [transportId, dest[0].id],
      );
      movingRows.push(`${token},${transportId},${deviceId}`);
    }
  }

  // 토큰은 인증 값이라 git 에 올리지 않는다 (perf/.gitignore)
  writeFileSync(medicsOut, `token\n${medics.join('\n')}\n`);
  writeFileSync(movingOut, `token,transportId,deviceId\n${movingRows.join('\n')}\n`);
  console.log(
    `부하 테스트용 대원 ${count}명(이동 중 이송 ${moving}건) 준비 완료 — 토큰은 15분 안에 쓰세요\n` +
      `  ${medicsOut}\n  ${movingOut}`,
  );
} finally {
  await pool.end();
}
