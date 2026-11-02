// 서버 시작점: 환경 변수 → DB·Redis 연결 → HTTP 서버
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const logger = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug' });

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const redis = new Redis(config.REDIS_URL, { lazyConnect: false });

// 이 처리기가 없으면 연결이 잠깐 끊겼을 때 서버 전체가 죽는다. /health가 503을 내면 충분하다.
pool.on('error', (err) => logger.error({ message: err.message }, 'DB 연결 오류'));
redis.on('error', (err) => logger.error({ message: err.message }, 'Redis 연결 오류'));

const app = createApp({
  logger,
  healthChecks: {
    db: () => pool.query('SELECT 1'),
    redis: () => redis.ping(),
  },
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, '서버 시작');
});

// 서버를 1대씩 교체하는 배포(COR-016)에서 처리 중인 요청을 끝내고 내려가게 한다.
let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  logger.info({ signal }, '서버 종료 시작');
  server.close(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
