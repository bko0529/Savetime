// 실제 DB·Redis를 쓰는 테스트의 접속 주소. docker compose와 CI가 같은 값을 쓴다.
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://savetime:savetime_local@localhost:5432/savetime';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

function urlFor(database: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

// 테스트마다 새 DB를 만들고 끝나면 지운다. 개발 DB는 건드리지 않는다.
// 기본 원본(template1)은 여러 테스트가 동시에 복사하면 충돌하므로 아무도 접속하지 않는 template0을 쓴다.
export async function withTempDatabase(use: (url: string) => Promise<void>): Promise<void> {
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  try {
    await use(urlFor(name));
  } finally {
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}
