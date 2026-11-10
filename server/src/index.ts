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
import { notifyExpiringKeys } from './modules/admin/notifications.js';
import { HOUSEKEEPING_EVERY_MS, releaseUnusedPcs } from './modules/admin/pcs.js';
import { RETENTION_EVERY_MS, runRetention } from './modules/privacy/retention.js';
import { startScheduledJob, type JobRunner, type ScheduledJob } from './modules/ops/queue.js';
import { createFcmSender } from './modules/push/fcm.js';
import { createRealtime } from './modules/realtime/server.js';
import { PAUSE_REMIND_EVERY_MS, remindLongPauses } from './modules/hospital-web/pause.js';
import { AUTO_END_EVERY_MS, endInactiveTransports } from './modules/transport/autoEnd.js';
import { PREV_PATIENT_SWEEP_EVERY_MS, releaseEndedTransports } from './modules/team/prevPatient.js';
import { createEtaLookup } from './modules/transport/eta.js';
import { createGeocoder } from './modules/transport/geocode.js';
import { createPhotoStore, createS3Storage, parsePhotoKey } from './modules/auth/photoStore.js';

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
if (config.APP_ROLE === 'main' && config.APP_ORIGINS.length === 0) {
  logger.warn('APP_ORIGINS가 비어 있어 브라우저의 구급대원 앱이 대원 API를 부를 수 없습니다');
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

const auth =
  config.APP_ROLE === 'main' && config.JWT_SECRET
    ? { pool, redis, jwtKey: signingKey(config.JWT_SECRET), shiftHours: config.SHIFT_MAX_HOURS }
    : undefined;
// 키가 없으면 푸시만 꺼진다. 앱이 켜져 있을 때의 실시간 알림은 그대로 (SFR-130)
const push = config.FIREBASE_SERVICE_ACCOUNT_BASE64
  ? createFcmSender(config.FIREBASE_SERVICE_ACCOUNT_BASE64)
  : undefined;
if (!push) logger.warn('FIREBASE_SERVICE_ACCOUNT_BASE64가 없어 푸시 알림을 보내지 않습니다');
// 실시간(Socket.IO): 대원·병원 서버(main)는 연결을 받고 타이머 작업도 돌린다.
// 관리자 서버(T-11)는 '보내기 전용': 연결은 받지 않고, 정지·PC 해제·가입 결과를 Redis 어댑터로 main 서버의 연결에 보낸다
const realtimeAuth =
  auth ??
  (config.APP_ROLE === 'admin' && config.JWT_SECRET
    ? { pool, redis, jwtKey: signingKey(config.JWT_SECRET), shiftHours: config.SHIFT_MAX_HOURS }
    : undefined);
const realtime = realtimeAuth
  ? createRealtime({
      auth: realtimeAuth,
      redisUrl: config.REDIS_URL,
      logger,
      push,
      runJobs: config.APP_ROLE === 'main',
    })
  : undefined;

// 관리자 API 는 관리자 서버에서만 켠다 (T-11). 개발 중에는 편하게 main 서버에서도 켠다
const adminEnabled =
  !!config.JWT_SECRET && (config.APP_ROLE === 'admin' || config.NODE_ENV === 'development');
// 운영 관리자 서버를 허용 IP 없이 켜면 누구나 관리자 로그인 화면에 닿는다. 아예 켜지 않는다
if (
  config.APP_ROLE === 'admin' &&
  config.NODE_ENV === 'production' &&
  config.ADMIN_ALLOWED_IPS.length === 0
) {
  throw new Error('관리자 서버는 ADMIN_ALLOWED_IPS를 채워야 켜집니다');
}

// 공무원증 사진 저장소 (SFR-017, SER-015). 값이 다 있어야 켠다. 암호화 키 길이가 틀리면 여기서 멈춘다
const photos =
  config.S3_ENDPOINT &&
  config.S3_BUCKET &&
  config.S3_ACCESS_KEY &&
  config.S3_SECRET_KEY &&
  config.PHOTO_ENC_KEY
    ? createPhotoStore(
        createS3Storage({
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          bucket: config.S3_BUCKET,
          accessKeyId: config.S3_ACCESS_KEY,
          secretAccessKey: config.S3_SECRET_KEY,
        }),
        parsePhotoKey(config.PHOTO_ENC_KEY),
      )
    : undefined;
if (!photos) logger.warn('S3_*·PHOTO_ENC_KEY가 없어 가입 신청(사진 저장)이 503이 됩니다');

const app = createApp({
  logger,
  // 대원 앱은 대원·병원 서버(main)만 부른다 (T-11)
  appOrigins: config.APP_ROLE === 'main' ? config.APP_ORIGINS : [],
  photos,
  eta,
  geocoder,
  auth,
  realtime,
  // 병원 웹 API 는 대원·병원 서버(main)에서만 켠다 (T-11)
  hospitalWeb:
    config.APP_ROLE === 'main'
      ? { pool, redis, allowedOrigins: config.ALLOWED_ORIGINS, realtime }
      : undefined,
  admin:
    adminEnabled && config.JWT_SECRET
      ? {
          pool,
          redis,
          jwtKey: signingKey(config.JWT_SECRET),
          sessionHours: config.SHIFT_MAX_HOURS,
          allowedOrigins: config.ALLOWED_ORIGINS,
          allowedIps: config.ADMIN_ALLOWED_IPS,
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
// REST와 같은 포트에서 /socket.io 경로로 받는다 (Caddy가 /socket.io를 서버로 넘김). 관리자 서버는 연결을 받지 않는다
if (config.APP_ROLE === 'main') realtime?.attach(server);

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

// 2시간 활동 없는 이송 건 자동 종료 (SFR-086). 키와 상관없이 항상 켠다
scheduledJobs.push({
  name: 'transport-auto-end',
  everyMs: AUTO_END_EVERY_MS,
  run: async () => {
    const events = await endInactiveTransports(pool, logger);
    realtime?.publish(events);
  },
});

// 종료 10분 뒤: 팀 연결 끊기(DAR-013) + 직전 환자 정보 비우기(SFR-157). 키와 상관없이 항상 켠다
scheduledJobs.push({
  name: 'transport-release-ended',
  everyMs: PREV_PATIENT_SWEEP_EVERY_MS,
  run: async () => {
    const events = await releaseEndedTransports(pool, logger);
    realtime?.publish(events);
  },
});

// 병원 요청 중지 2시간째 알림 (SFR-139)
scheduledJobs.push({
  name: 'hospital-pause-reminder',
  everyMs: PAUSE_REMIND_EVERY_MS,
  run: async () => {
    const events = await remindLongPauses(pool, redis, logger);
    realtime?.publish(events);
  },
});

// 병원 PC·키 정리: 90일 안 쓴 PC 등록 자동 해제(SFR-147) + 키 만료 30·7·1일 전 관리자 알림(SFR-100).
// 하루 단위 기준이라 1시간마다 돌아도 충분하다
scheduledJobs.push({
  name: 'hospital-pc-housekeeping',
  everyMs: HOUSEKEEPING_EVERY_MS,
  run: async () => {
    const released = await releaseUnusedPcs(pool);
    const expiring = await notifyExpiringKeys(pool);
    if (released || expiring) logger.info({ released, expiring }, '병원 PC·키 정리');
  },
});

// 개인정보 자동 파기 (DAR-003·010·012·014): 환자 평가 30일, 미처리 가입 사진 30일, 반려 신청 30일, 익명 경로 3년.
// 하루 단위 기준이라 1시간마다 돌아도 충분하다. 사진 만료 반려는 신청자에게 알린다 (커밋 뒤)
scheduledJobs.push({
  name: 'privacy-retention',
  everyMs: RETENTION_EVERY_MS,
  run: async () => {
    const events = await runRetention({ pool, redis, photos, logger });
    realtime?.publish(events);
  },
});

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
  // 실시간 연결을 먼저 끊어야 HTTP 서버가 닫힌다
  void Promise.allSettled([realtime?.close()]).then(() => server.close(onClosed));
  async function onClosed() {
    await Promise.allSettled(jobRunners.map((runner) => runner.close()));
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
