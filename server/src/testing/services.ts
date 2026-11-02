// 실제 DB·Redis를 쓰는 테스트의 접속 주소. docker compose와 CI가 같은 값을 쓴다.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://savetime:savetime_local@localhost:5432/savetime';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
