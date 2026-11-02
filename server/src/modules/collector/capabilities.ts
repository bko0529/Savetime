// 중증질환 진료가능 항목 수집, 1시간마다 (INR-001, SFR-007)
import type pg from 'pg';
import type { Logger } from 'pino';
import { runPool } from './pool.js';
import { CollectError, type FetchItems } from './publicApi.js';
import type { ApiQuota } from './quota.js';
import { saveFailure } from './round.js';

export const COLLECT_CAPABILITIES_EVERY_MS = 3_600_000;
const OPERATION = 'getSrsillDissAceptncPosblInfoInqire';
const DEADLINE_MS = 150_000;
const CONCURRENT_REGIONS = 4;
const ITEM_COUNT = 27; // MKioskTy28(응급실 Gate Keeper)은 진료가능 항목이 아니라서 뺀다

export interface CapabilityRow {
  publicId: string;
  code: string;
  available: boolean;
}

// 'Y         '처럼 뒤에 공백이 붙어서 온다. '정보미제공'은 불가와 달라서 행을 만들지 않는다.
function toAvailable(value: unknown): boolean | undefined {
  const text = String(value ?? '').trim();
  if (text === 'Y') return true;
  if (text === 'N' || text === '불가능') return false;
  return undefined;
}

export function parseCapabilities(items: unknown[]): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  for (const item of items) {
    const record = item as Record<string, unknown>;
    if (typeof record.hpid !== 'string') continue;
    for (let n = 1; n <= ITEM_COUNT; n += 1) {
      const available = toAvailable(record[`MKioskTy${n}`]);
      if (available === undefined) continue;
      rows.push({ publicId: record.hpid, code: `mkioskty${n}`, available });
    }
  }
  return rows;
}

// 응답에 온 병원은 통째로 바꾼다. '가능'이었다가 '정보미제공'이 된 항목이 남지 않게 한다.
async function saveRegion(
  pool: pg.Pool,
  region: string,
  startedAt: Date,
  publicIds: string[],
  rows: CapabilityRow[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM hospital_capability c USING hospital h
        WHERE h.id = c.hospital_id AND h.public_id = ANY($1::varchar[])`,
      [publicIds],
    );
    await client.query(
      `INSERT INTO hospital_capability (hospital_id, item_code, available, updated_at)
       SELECT h.id, x.code, x.available, now()
         FROM jsonb_to_recordset($1::jsonb) AS x("publicId" varchar, code varchar, available boolean)
         JOIN hospital h ON h.public_id = x."publicId"`,
      [JSON.stringify(rows)],
    );
    await client.query(
      `INSERT INTO collect_log (kind, region, started_at, finished_at, success, hospital_count)
       VALUES ('capabilities', $1, $2, now(), true, $3)`,
      [region, startedAt, publicIds.length],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface CapabilityCollectDeps {
  pool: pg.Pool;
  fetchItems: FetchItems;
  quota: ApiQuota;
  regions: string[];
  logger: Logger;
}

export async function runCapabilityCollect(deps: CapabilityCollectDeps): Promise<void> {
  const { pool, fetchItems, quota, regions, logger } = deps;
  if (await quota.isExhausted()) return;

  const signal = AbortSignal.timeout(DEADLINE_MS);
  let quotaReached = false;

  await runPool(
    regions,
    CONCURRENT_REGIONS,
    () => signal.aborted || quotaReached,
    async (region) => {
      const startedAt = new Date();
      try {
        const items = await fetchItems(OPERATION, { STAGE1: region }, signal);
        if (items.length === 0) throw new CollectError('EMPTY_REGION');
        const publicIds = items
          .map((item) => (item as { hpid?: unknown }).hpid)
          .filter((id): id is string => typeof id === 'string');
        await saveRegion(pool, region, startedAt, publicIds, parseCapabilities(items));
      } catch (err) {
        const code = err instanceof CollectError ? err.code : 'SAVE_FAILED';
        if (code === 'QUOTA_EXCEEDED') quotaReached = true;
        if (code === 'SAVE_FAILED') {
          logger.error({ region, message: (err as Error).message }, '진료가능 항목 저장 실패');
        }
        await saveFailure(pool, region, startedAt, code, 'capabilities');
      }
    },
  );

  await quota.save();
}
