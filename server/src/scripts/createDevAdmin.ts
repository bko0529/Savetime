// 개발용 관리자 계정 만들기: npm run admin:dev -w server -- [아이디]
// 관리자는 가입이 없고 초기 데이터로만 만든다 (COR-007). 운영 DB에서는 실행하지 않는다.
// 같은 아이디가 있으면 비밀번호를 새로 정하고, 잠금과 OTP 연결을 풀어 첫 로그인부터 다시 해 볼 수 있게 한다.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { hashPassword } from '../modules/auth/password.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('운영 환경에서는 개발용 관리자를 만들 수 없어요 (NODE_ENV=development 확인)');
  process.exit(1);
}

const loginId = process.argv[2] ?? 'admin-dev';
// 비밀번호를 정해 주지 않으면 무작위로 만들어 이 화면에 한 번만 보여 준다. DB에는 해시만 남는다.
const password = process.env.DEV_ACCOUNT_PASSWORD || randomBytes(9).toString('base64url');

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  await pool.query(
    `INSERT INTO admin (login_id, password_hash, name) VALUES ($1, $2, '개발 관리자')
     ON CONFLICT (login_id) DO UPDATE
       SET password_hash = excluded.password_hash, failed_count = 0, locked_until = NULL,
           otp_secret = NULL, otp_enrolled_at = NULL`,
    [loginId, await hashPassword(password)],
  );
  console.log(
    `개발용 관리자 준비 완료 (첫 로그인 때 OTP 앱 연결)\n  아이디: ${loginId}\n  비밀번호: ${password}`,
  );
} finally {
  await pool.end();
}
