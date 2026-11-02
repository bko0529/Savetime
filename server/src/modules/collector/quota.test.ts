// SFR-090 인수 기준을 실제 Redis와 임시 DB로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino, type Logger } from 'pino';
import { TEST_REDIS_URL, withTempDatabase } from '../../testing/services.js';
import type { BedRow } from './parseBeds.js';
import { createFetchBeds } from './publicApi.js';
import { createApiQuota, type ApiQuotaOptions } from './quota.js';
import { runCollectRound } from './round.js';

const SCHEMA_FILE = fileURLToPath(new URL('../../../db/schema.sql', import.meta.url));

interface Harness {
  pool: pg.Pool;
  redis: Redis;
  options: Omit<ApiQuotaOptions, 'limit'>;
  alerts: string[];
  day: { value: string };
}

async function withQuota(use: (h: Harness) => Promise<void>): Promise<void> {
  await withTempDatabase(async (url) => {
    const pool = new pg.Pool({ connectionString: url });
    pool.on('error', () => {});
    const redis = new Redis(TEST_REDIS_URL);
    const api = `t_${randomBytes(6).toString('hex')}`;
    const alerts: string[] = [];
    const day = { value: '2026-11-02' };
    const logger = { error: (_data: unknown, msg: string) => alerts.push(msg) };
    try {
      await pool.query(await readFile(SCHEMA_FILE, 'utf8'));
      await use({
        pool,
        redis,
        alerts,
        day,
        options: {
          redis,
          pool,
          api,
          logger: logger as unknown as Logger,
          today: async () => day.value,
        },
      });
    } finally {
      const keys = await redis.keys(`api-calls:${api}:*`);
      if (keys.length > 0) await redis.del(keys);
      await redis.quit();
      await pool.end();
    }
  });
}

async function takeTimes(take: () => Promise<void>, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) await take();
}

test('80%에 닿으면 하루 1번만 알리고 수집은 계속된다', async () => {
  await withQuota(async ({ options, alerts }) => {
    const quota = createApiQuota({ ...options, limit: 10 });
    await takeTimes(quota.take, 7);
    assert.deepEqual(alerts, []);
    await takeTimes(quota.take, 2);
    assert.deepEqual(alerts, ['공공 API 호출 80%']);
    assert.equal(await quota.isExhausted(), false);
  });
});

test('한도에 닿으면 더 호출하지 못하고, 수는 한도를 넘지 않는다', async () => {
  await withQuota(async ({ options, redis, alerts, day }) => {
    const quota = createApiQuota({ ...options, limit: 3 });
    await takeTimes(quota.take, 3);
    await assert.rejects(quota.take(), { code: 'QUOTA_EXCEEDED' });
    await assert.rejects(quota.take(), { code: 'QUOTA_EXCEEDED' });

    assert.equal(await quota.isExhausted(), true);
    assert.equal(await redis.get(`api-calls:${options.api}:${day.value}`), '3');
    assert.equal(alerts.filter((msg) => msg === '공공 API 호출 한도 초과').length, 1);
  });
});

test('서버 2대가 동시에 호출해도 수를 하나로 합쳐 센다', async () => {
  await withQuota(async ({ options }) => {
    const first = createApiQuota({ ...options, limit: 5 });
    const second = createApiQuota({ ...options, limit: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).take()),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5);
  });
});

test('날짜가 바뀌면 다시 호출할 수 있다', async () => {
  await withQuota(async ({ options, day }) => {
    const quota = createApiQuota({ ...options, limit: 1 });
    await quota.take();
    assert.equal(await quota.isExhausted(), true);

    day.value = '2026-11-03';
    assert.equal(await quota.isExhausted(), false);
    await quota.take();
  });
});

test('호출 수를 DB에 남기고, Redis가 비어도 그 수부터 이어서 센다', async () => {
  await withQuota(async ({ options, pool, redis, day }) => {
    const quota = createApiQuota({ ...options, limit: 3 });
    await takeTimes(quota.take, 3);
    await quota.save();
    const { rows } = await pool.query('SELECT calls FROM api_call_daily');
    assert.equal(rows[0].calls, 3);

    await redis.del(`api-calls:${options.api}:${day.value}`);
    assert.equal(await quota.isExhausted(), true);
  });
});

test('한도를 다 쓴 날에는 수집 요청을 보내지 않고 다음 날 다시 시작한다', async () => {
  await withQuota(async ({ options, pool, day }) => {
    const quota = createApiQuota({ ...options, limit: 1 });
    await quota.take();

    let calls = 0;
    const fetchBeds = async (): Promise<BedRow[]> => {
      calls += 1;
      return [{ publicId: 'x', sourceTime: '2026-11-02T14:03:00+09:00', raw: {}, excluded: false }];
    };
    const deps = {
      pool,
      fetchBeds,
      quota,
      regions: ['충청남도', '세종특별자치시'],
      logger: pino({ level: 'silent' }),
    };

    const stopped = await runCollectRound(deps);
    assert.deepEqual(stopped, { succeeded: 0, failed: 0, notStarted: 2 });
    assert.equal(calls, 0);

    day.value = '2026-11-03';
    assert.equal((await runCollectRound(deps)).succeeded, 2);
  });
});

test('회차 중간에 한도에 닿으면 남은 시·도는 시작하지 않는다', async () => {
  await withQuota(async ({ options, pool }) => {
    const quota = createApiQuota({ ...options, limit: 6 });
    let sent = 0;
    const fetchBeds = createFetchBeds('key', quota.take, (async () => {
      sent += 1;
      return Response.json({
        response: { header: { resultCode: '00' }, body: { items: '' } },
      });
    }) as typeof fetch);
    const regions = Array.from({ length: 17 }, (_, i) => `시도${i}`);

    const result = await runCollectRound({
      pool,
      fetchBeds,
      quota,
      regions,
      logger: pino({ level: 'silent' }),
    });

    assert.equal(sent, 6);
    assert.ok(result.notStarted > 0, `시작 못 한 시·도 ${result.notStarted}`);
    const { rows } = await pool.query(
      `SELECT count(*) FROM collect_log WHERE error_code = 'QUOTA_EXCEEDED'`,
    );
    assert.ok(Number(rows[0].count) >= 1);
    const saved = await pool.query('SELECT calls FROM api_call_daily');
    assert.equal(saved.rows[0].calls, 6);
  });
});
