// 개발용 대원 계정 만들기: npm run account:dev -- [아이디]
// 가입·승인 기능(S5)이 생기기 전까지 앱에서 로그인을 시험하려고 쓴다. 운영 DB에서는 실행하지 않는다.
// 같은 아이디가 있으면 비밀번호를 새로 정하고 잠금을 푼다.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { hashPassword } from '../modules/auth/password.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('운영 환경에서는 개발용 계정을 만들 수 없어요 (NODE_ENV=development 확인)');
  process.exit(1);
}

const loginId = process.argv[2] ?? 'dev1';
// 비밀번호를 정해 주지 않으면 무작위로 만들어 이 화면에 한 번만 보여 준다. 파일·DB에는 해시만 남는다.
const password = process.env.DEV_ACCOUNT_PASSWORD || randomBytes(9).toString('base64url');

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  await pool.query(
    `WITH a AS (
       INSERT INTO agency (code, name, region) VALUES ('DEV-000', '개발용 소방서', '충청남도')
       ON CONFLICT (code) DO UPDATE SET name = excluded.name RETURNING id
     )
     INSERT INTO paramedic
       (login_id, password_hash, name, rank, agency_id, safety_center, employee_no, status)
     SELECT $1, $2, '개발 대원', '소방사', a.id, '개발용 안전센터', $1, 'approved' FROM a
     ON CONFLICT (login_id) DO UPDATE
       SET password_hash = excluded.password_hash, status = 'approved',
           failed_count = 0, locked_until = NULL,
           session_version = paramedic.session_version + 1`,
    [loginId, await hashPassword(password)],
  );
  console.log(`개발용 계정 준비 완료\n  아이디: ${loginId}\n  비밀번호: ${password}`);
} finally {
  await pool.end();
}
