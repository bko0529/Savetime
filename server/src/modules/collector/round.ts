// 병상 수집 한 회차 (SFR-023). 회차가 겹치지 않는 것은 주기 작업 틀이 보장한다.
import type pg from 'pg';
import type { Logger } from 'pino';
import type { BedRow } from './parseBeds.js';
import { runPool } from './pool.js';
import { CollectError, type FetchBeds } from './publicApi.js';
import type { ApiQuota } from './quota.js';

export const ALL_REGIONS = [
  '서울특별시',
  '부산광역시',
  '대구광역시',
  '인천광역시',
  '광주광역시',
  '대전광역시',
  '울산광역시',
  '세종특별자치시',
  '경기도',
  '강원특별자치도',
  '충청북도',
  '충청남도',
  '전북특별자치도',
  '전라남도',
  '경상북도',
  '경상남도',
  '제주특별자치도',
];

// 설정값은 쉼표로 구분한다. 비우면 전국 17개 (T-07)
export function regionsFrom(value: string | undefined): string[] {
  return value ? value.split(',').map((region) => region.trim()) : ALL_REGIONS;
}

export const COLLECT_EVERY_MS = 180_000;
const ROUND_DEADLINE_MS = 150_000;
const CONCURRENT_REGIONS = 4;

export interface RoundDeps {
  pool: pg.Pool;
  fetchBeds: FetchBeds;
  quota: ApiQuota;
  regions: string[];
  logger: Logger;
  deadlineMs?: number;
}

export interface RoundResult {
  succeeded: number;
  failed: number;
  notStarted: number;
}

// 마지막 성공이 오래된 시·도부터 수집한다. 못 끝낸 시·도가 자연히 맨 앞에 온다.
// 순서를 메모리에 기억하지 않으므로 서버가 바뀌어도 그대로 이어진다.
async function orderRegions(pool: pg.Pool, regions: string[]): Promise<string[]> {
  const { rows } = await pool.query<{ region: string }>(
    `SELECT r.region
       FROM unnest($1::text[]) WITH ORDINALITY AS r(region, position)
       LEFT JOIN LATERAL (
         SELECT max(started_at) AS last_success
           FROM collect_log
          WHERE kind = 'beds' AND region = r.region AND success
       ) l ON true
      ORDER BY l.last_success ASC NULLS FIRST, r.position`,
    [regions],
  );
  return rows.map((row) => row.region);
}

// 병상과 수집 기록을 한 트랜잭션으로 저장한다. 값은 바뀌었는데 기록이 없는 상태를 막는다.
// 공공 데이터에 있어도 hospital에 없는 병원은 JOIN에서 빠진다.
async function saveSuccess(
  pool: pg.Pool,
  region: string,
  startedAt: Date,
  beds: BedRow[],
): Promise<void> {
  const rows = beds.map((bed) => ({
    ...bed,
    raw: JSON.stringify(bed.raw),
    detail: {
      er: [bed.erAvail, bed.erTotal],
      icu: [bed.icuAvail, bed.icuTotal],
      or: [bed.orAvail, bed.orTotal],
    },
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 이상치가 처음 생길 때만 남긴다. 3분마다 같은 기록이 쌓이지 않게 한다.
    await client.query(
      `INSERT INTO bed_anomaly_log (public_id, reason, detail)
       SELECT x."publicId", 'avail_over_total', x.detail
         FROM jsonb_to_recordset($1::jsonb) AS x("publicId" varchar, excluded boolean, detail jsonb)
         JOIN hospital h ON h.public_id = x."publicId"
         LEFT JOIN bed_current c ON c.hospital_id = h.id
        WHERE x.excluded AND NOT coalesce(c.excluded, false)`,
      [JSON.stringify(rows)],
    );
    const saved = await client.query(
      `INSERT INTO bed_current AS c
         (hospital_id, er_avail, er_total, icu_avail, icu_total, or_avail, or_total,
          source_time, collected_at, raw, excluded)
       SELECT h.id, x."erAvail", x."erTotal", x."icuAvail", x."icuTotal", x."orAvail", x."orTotal",
              x."sourceTime", now(), x.raw::jsonb, x.excluded
         FROM jsonb_to_recordset($1::jsonb) AS x(
                "publicId" varchar, "erAvail" int, "erTotal" int, "icuAvail" int, "icuTotal" int,
                "orAvail" int, "orTotal" int, "sourceTime" timestamptz, raw text, excluded boolean)
         JOIN hospital h ON h.public_id = x."publicId"
       ON CONFLICT (hospital_id) DO UPDATE SET
         er_avail = excluded.er_avail, er_total = excluded.er_total,
         icu_avail = excluded.icu_avail, icu_total = excluded.icu_total,
         or_avail = excluded.or_avail, or_total = excluded.or_total,
         source_time = excluded.source_time, collected_at = excluded.collected_at,
         raw = excluded.raw, excluded = excluded.excluded
       RETURNING hospital_id`,
      [JSON.stringify(rows)],
    );
    await client.query(
      `INSERT INTO bed_history
         (hospital_id, collected_at, er_avail, er_total, icu_avail, icu_total, or_avail, or_total)
       SELECT hospital_id, collected_at, er_avail, er_total, icu_avail, icu_total, or_avail, or_total
         FROM bed_current
        WHERE hospital_id = ANY($1::bigint[])
       ON CONFLICT DO NOTHING`,
      [saved.rows.map((row) => row.hospital_id)],
    );
    const sourceTimes = beds.map((bed) => bed.sourceTime);
    await client.query(
      `INSERT INTO collect_log
         (region, started_at, finished_at, success, source_time, hospital_count)
       VALUES ($1, $2, now(), true,
               (SELECT max(t) FROM unnest($3::timestamptz[]) AS t), $4)`,
      [region, startedAt, sourceTimes, saved.rows.length],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function saveFailure(
  pool: pg.Pool,
  region: string,
  startedAt: Date,
  errorCode: string,
  kind: 'beds' | 'hospitals' | 'capabilities' = 'beds',
): Promise<void> {
  await pool.query(
    `INSERT INTO collect_log (kind, region, started_at, finished_at, success, error_code)
     VALUES ($1, $2, $3, now(), false, $4)`,
    [kind, region, startedAt, errorCode],
  );
}

export async function runCollectRound(deps: RoundDeps): Promise<RoundResult> {
  const { pool, fetchBeds, quota, regions, logger, deadlineMs = ROUND_DEADLINE_MS } = deps;
  // 한도를 다 쓰면 저장된 데이터로만 서비스한다 (SFR-090)
  if (await quota.isExhausted()) {
    return { succeeded: 0, failed: 0, notStarted: regions.length };
  }

  const signal = AbortSignal.timeout(deadlineMs);
  const pending = await orderRegions(pool, regions);
  const result: RoundResult = { succeeded: 0, failed: 0, notStarted: 0 };
  let quotaReached = false;

  const collectRegion = async (region: string): Promise<void> => {
    const startedAt = new Date();
    try {
      const beds = await fetchBeds(region, signal);
      // 시·도 이름이 틀려도 공공 API는 0건을 정상으로 돌려준다. 성공으로 남기면 못 알아챈다.
      if (beds.length === 0) throw new CollectError('EMPTY_REGION');
      await saveSuccess(pool, region, startedAt, beds);
      result.succeeded += 1;
    } catch (err) {
      const code = err instanceof CollectError ? err.code : 'SAVE_FAILED';
      if (code === 'QUOTA_EXCEEDED') quotaReached = true;
      if (code === 'SAVE_FAILED') {
        logger.error({ region, message: (err as Error).message }, '병상 저장 실패');
      }
      // 한 시·도가 실패해도 나머지는 계속한다. 기존 값과 기준 시각은 그대로 남는다.
      await saveFailure(pool, region, startedAt, code);
      result.failed += 1;
    }
  };

  // 4곳이 끝날 때마다 묶어서 기다리지 않고, 한 곳이 끝나면 바로 다음 시·도를 시작한다.
  result.notStarted = await runPool(
    pending,
    CONCURRENT_REGIONS,
    () => signal.aborted || quotaReached,
    collectRegion,
  );
  await quota.save();
  logger.info(result, '병상 수집 회차 종료');
  return result;
}
