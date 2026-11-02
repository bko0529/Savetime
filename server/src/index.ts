// 서버 시작점: 환경 변수 → DB·Redis 연결 → HTTP 서버
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createFetchBeds } from './modules/collector/publicApi.js';
import { createApiQuota } from './modules/collector/quota.js';
import { ALL_REGIONS, COLLECT_EVERY_MS, runCollectRound } from './modules/collector/round.js';
import { startScheduledJob, type JobRunner, type ScheduledJob } from './modules/ops/queue.js';

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

// 키가 없어도 서버는 켜진다. 수집만 빠지고 저장된 데이터로 동작한다.
const scheduledJobs: ScheduledJob[] = [];
if (config.PUBLIC_DATA_API_KEY) {
  const quota = createApiQuota({
    redis,
    pool,
    logger,
    limit: config.PUBLIC_DATA_DAILY_LIMIT,
  });
  const fetchBeds = createFetchBeds(config.PUBLIC_DATA_API_KEY, quota.take);
  const regions = config.COLLECT_REGIONS
    ? config.COLLECT_REGIONS.split(',').map((region) => region.trim())
    : ALL_REGIONS;
  scheduledJobs.push({
    name: 'collect-beds',
    everyMs: COLLECT_EVERY_MS,
    run: async () => {
      await runCollectRound({ pool, fetchBeds, quota, regions, logger });
    },
  });
} else {
  logger.warn('PUBLIC_DATA_API_KEY가 없어 병상 수집을 켜지 않습니다');
}

// 관리자 서버는 주기 작업을 맡지 않는다 (T-11).
const jobRunners: JobRunner[] =
  config.APP_ROLE === 'main'
    ? scheduledJobs.map((job) => startScheduledJob(job, { url: config.REDIS_URL }, logger))
    : [];

// 서버를 1대씩 교체하는 배포(COR-016)에서 처리 중인 요청을 끝내고 내려가게 한다.
const SHUTDOWN_TIMEOUT_MS = 30_000;
let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  logger.info({ signal }, '서버 종료 시작');
  // Redis가 끊기면 워커가 닫히지 못해 배포가 멈춘다. 끊긴 작업은 다른 서버가 이어받는다.
  setTimeout(() => {
    logger.error('제한 시간 안에 종료하지 못해 강제로 끝냅니다');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close(async () => {
    await Promise.allSettled(jobRunners.map((runner) => runner.close()));
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
