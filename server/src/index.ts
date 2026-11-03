// 서버 시작점: 환경 변수 → DB·Redis 연결 → HTTP 서버
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { signingKey } from './modules/auth/tokens.js';
import {
  COLLECT_CAPABILITIES_EVERY_MS,
  runCapabilityCollect,
} from './modules/collector/capabilities.js';
import { COLLECT_HOSPITALS_EVERY_MS, runHospitalCollect } from './modules/collector/hospitals.js';
import { createFetchBeds, createFetchItems } from './modules/collector/publicApi.js';
import { createApiQuota } from './modules/collector/quota.js';
import { COLLECT_EVERY_MS, regionsFrom, runCollectRound } from './modules/collector/round.js';
import { startScheduledJob, type JobRunner, type ScheduledJob } from './modules/ops/queue.js';
import { createEtaLookup } from './modules/transport/eta.js';
import { createGeocoder } from './modules/transport/geocode.js';

const config = loadConfig();
const logger = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug' });

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const redis = new Redis(config.REDIS_URL, { lazyConnect: false });

// 이 처리기가 없으면 연결이 잠깐 끊겼을 때 서버 전체가 죽는다. /health가 503을 내면 충분하다.
pool.on('error', (err) => logger.error({ message: err.message }, 'DB 연결 오류'));
redis.on('error', (err) => logger.error({ message: err.message }, 'Redis 연결 오류'));

// 서명 키 없이 켜면 대원·관리자 모두 로그인을 못 한다. 빠뜨렸으면 켜지 않는다.
if (!config.JWT_SECRET) {
  throw new Error('환경 변수를 확인하세요: JWT_SECRET');
}

// 카카오 키가 없어도 서버는 켜진다. 추천 카드의 예상 이동시간만 '없음'이 된다 (SFR-073)
const eta = config.KAKAO_REST_API_KEY
  ? createEtaLookup({
      apiKey: config.KAKAO_REST_API_KEY,
      redis,
      logger,
      quota: createApiQuota({
        redis,
        pool,
        logger,
        limit: config.KAKAO_DIRECTIONS_DAILY_LIMIT,
        api: 'kakao_directions',
        label: '카카오 길찾기',
      }),
    })
  : undefined;
if (config.ALLOWED_ORIGINS.length === 0) {
  logger.warn('ALLOWED_ORIGINS가 비어 있어 병원 웹 요청의 Origin을 검사하지 않습니다');
}
if (!eta) logger.warn('KAKAO_REST_API_KEY가 없어 예상 이동시간을 구하지 않습니다');

// 같은 카카오 키를 쓴다. 키가 없으면 주소→좌표만 503이 된다 (SFR-009)
const geocoder = config.KAKAO_REST_API_KEY
  ? createGeocoder({
      apiKey: config.KAKAO_REST_API_KEY,
      quota: createApiQuota({
        redis,
        pool,
        logger,
        limit: config.KAKAO_LOCAL_DAILY_LIMIT,
        api: 'kakao_local',
        label: '카카오 로컬',
      }),
    })
  : undefined;

const app = createApp({
  logger,
  eta,
  geocoder,
  auth:
    config.APP_ROLE === 'main' && config.JWT_SECRET
      ? { pool, redis, jwtKey: signingKey(config.JWT_SECRET), shiftHours: config.SHIFT_MAX_HOURS }
      : undefined,
  // 병원 웹 API 는 대원·병원 서버(main)에서만 켠다 (T-11)
  hospitalWeb:
    config.APP_ROLE === 'main'
      ? { pool, redis, allowedOrigins: config.ALLOWED_ORIGINS }
      : undefined,
  // 관리자 API 는 관리자 서버와, S7 에 서버를 나누기 전까지는 대원·병원 서버에서도 켠다 (T-11)
  admin: config.JWT_SECRET
    ? {
        pool,
        redis,
        jwtKey: signingKey(config.JWT_SECRET),
        sessionHours: config.SHIFT_MAX_HOURS,
        allowedOrigins: config.ALLOWED_ORIGINS,
      }
    : undefined,
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
  const fetchItems = createFetchItems(config.PUBLIC_DATA_API_KEY, quota);
  const fetchBeds = createFetchBeds(fetchItems, (region, count) => {
    logger.warn({ region, count }, '형식이 맞지 않는 병원을 건너뜁니다');
  });
  const regions = regionsFrom(config.COLLECT_REGIONS);
  const deps = { pool, fetchItems, quota, regions, logger };
  scheduledJobs.push(
    {
      name: 'collect-beds',
      everyMs: COLLECT_EVERY_MS,
      run: async () => {
        await runCollectRound({ pool, fetchBeds, quota, regions, logger });
      },
    },
    {
      name: 'collect-hospitals',
      everyMs: COLLECT_HOSPITALS_EVERY_MS,
      run: () => runHospitalCollect(deps),
    },
    {
      name: 'collect-capabilities',
      everyMs: COLLECT_CAPABILITIES_EVERY_MS,
      run: () => runCapabilityCollect(deps),
    },
  );
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
