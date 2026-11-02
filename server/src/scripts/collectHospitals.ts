// 병원 기본정보·진료가능 항목을 지금 바로 한 번 수집한다. 처음 DB를 만든 뒤 하루를 기다리지 않으려고 쓴다.
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { loadConfig } from '../config.js';
import { runCapabilityCollect } from '../modules/collector/capabilities.js';
import { runHospitalCollect } from '../modules/collector/hospitals.js';
import { createFetchItems } from '../modules/collector/publicApi.js';
import { createApiQuota } from '../modules/collector/quota.js';
import { regionsFrom } from '../modules/collector/round.js';

const config = loadConfig();
if (!config.PUBLIC_DATA_API_KEY) throw new Error('PUBLIC_DATA_API_KEY가 필요합니다');

const logger = pino();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const redis = new Redis(config.REDIS_URL);
const quota = createApiQuota({ redis, pool, logger, limit: config.PUBLIC_DATA_DAILY_LIMIT });
const deps = {
  pool,
  quota,
  logger,
  fetchItems: createFetchItems(config.PUBLIC_DATA_API_KEY, quota),
  regions: regionsFrom(config.COLLECT_REGIONS),
};

await runHospitalCollect(deps);
await runCapabilityCollect(deps);
await pool.end();
await redis.quit();
