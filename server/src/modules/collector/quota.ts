// 공공 데이터 하루 호출 수 (SFR-090). 서버가 여러 대여도 하나로 세려고 Redis에 둔다 (COR-016).
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { CollectError } from './publicApi.js';

const KEY_TTL_SECONDS = 2 * 24 * 60 * 60;
const WARN_RATIO = 0.8;

export interface ApiQuota {
  // 공공 API를 부르기 직전에 1회분을 쓴다. 한도에 닿았으면 CollectError를 던진다.
  take: () => Promise<void>;
  // 회차를 시작해도 되는지 본다. 오늘 한도를 다 썼으면 true.
  isExhausted: () => Promise<boolean>;
  // 공공 API가 한도 초과라고 답하면 오늘 호출을 멈춘다.
  exhaust: () => Promise<void>;
  // 회차가 끝나면 호출 수를 DB에 남긴다.
  save: () => Promise<void>;
}

export interface ApiQuotaOptions {
  redis: Redis;
  pool: pg.Pool;
  logger: Logger;
  limit: number;
  api?: string;
  // 로그 문구에 쓰는 이름. 길찾기처럼 다른 API도 같은 방식으로 센다
  label?: string;
  today?: () => Promise<string>;
}

export function createApiQuota(options: ApiQuotaOptions): ApiQuota {
  const { redis, pool, logger, limit, api = 'public_data', label = '공공 API' } = options;

  // 날짜가 바뀌면 키가 달라져서 수가 자연히 0부터 시작한다. 서버 시계 대신 DB 시각을 쓴다.
  const today =
    options.today ??
    (async () => {
      const { rows } = await pool.query<{ day: string }>(
        `SELECT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day`,
      );
      return rows[0].day;
    });
  const countKey = (day: string) => `api-calls:${api}:${day}`;

  // 관리자 알림 목록이 생기는 S5 전까지는 오류 로그로 남긴다. 하루에 단계별 1번만.
  const alertOnce = async (day: string, stage: string, used: number): Promise<void> => {
    const first = await redis.set(
      `${countKey(day)}:alert:${stage}`,
      '1',
      'EX',
      KEY_TTL_SECONDS,
      'NX',
    );
    if (first) logger.error({ api, day, used, limit }, `${label} 호출 ${stage}`);
  };

  return {
    take: async () => {
      const day = await today();
      const key = countKey(day);
      // INCR은 Redis에서 한 번에 처리되어 서버 2대가 동시에 불러도 수가 빠지지 않는다.
      const used = await redis.incr(key);
      if (used === 1) await redis.expire(key, KEY_TTL_SECONDS);
      if (used > limit) {
        await redis.decr(key);
        await alertOnce(day, '한도 초과', limit);
        throw new CollectError('QUOTA_EXCEEDED');
      }
      if (used >= limit * WARN_RATIO) await alertOnce(day, '80%', used);
    },

    isExhausted: async () => {
      const day = await today();
      const key = countKey(day);
      // Redis가 비었으면 DB 기록에서 이어서 센다. 0부터 세면 한도를 넘겨 호출하게 된다.
      const { rows } = await pool.query<{ calls: number }>(
        'SELECT calls FROM api_call_daily WHERE api = $1 AND day = $2',
        [api, day],
      );
      await redis.set(key, rows[0]?.calls ?? 0, 'EX', KEY_TTL_SECONDS, 'NX');

      const used = Number(await redis.get(key));
      if (used < limit) return false;
      await alertOnce(day, '한도 초과', used);
      return true;
    },

    exhaust: async () => {
      const day = await today();
      await redis.set(countKey(day), limit, 'EX', KEY_TTL_SECONDS);
      await alertOnce(day, '한도 초과', limit);
    },

    save: async () => {
      const day = await today();
      const used = Number(await redis.get(countKey(day)));
      // 두 서버의 저장 순서가 뒤바뀌어도 수가 줄지 않게 큰 값을 남긴다.
      await pool.query(
        `INSERT INTO api_call_daily (api, day, calls) VALUES ($1, $2, $3)
         ON CONFLICT (api, day) DO UPDATE
           SET calls = greatest(api_call_daily.calls, excluded.calls), updated_at = now()`,
        [api, day, used],
      );
    },
  };
}
