// 병원 기본정보·등급 수집, 1일 1회 (INR-001, DAR-008, SFR-162)
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { recordFailure } from './collectLog.js';
import { lastByKey, optionalNumber, optionalText } from './fields.js';
import { runPool } from './pool.js';
import { CollectError, type FetchItems } from './publicApi.js';
import type { ApiQuota } from './quota.js';

export const COLLECT_HOSPITALS_EVERY_MS = 86_400_000;
const LIST_OPERATION = 'getEgytListInfoInqire';
const BASIC_OPERATION = 'getEgytBassInfoInqire';
const DEADLINE_MS = 1_800_000;
const CONCURRENT_REGIONS = 4;
const CONCURRENT_HOSPITALS = 4;
const MAX_NAME_LENGTH = 80; // 공공 데이터는 100자까지 허용해서 DB 컬럼에 맞춘다

// 부록 F. 여기 없는 종별(응급실운영신고기관 등)과 빈 값은 일반 병원이다.
export const EMCLS_TO_GRADE: Record<string, number> = {
  권역응급의료센터: 1,
  지역응급의료센터: 2,
  지역응급의료기관: 3,
};
const DEFAULT_GRADE = 3;

// 대한민국 영역 (SFR-087). 값이 있어도 0처럼 이 밖이면 좌표가 없는 것으로 본다.
function isInKorea(lat: number | undefined, lng: number | undefined): boolean {
  return (
    lat !== undefined && lng !== undefined && lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132
  );
}

const listItemSchema = z.object({
  hpid: z.string().min(1),
  dutyName: z.string().min(1),
  dutyAddr: optionalText,
  dutyTel1: optionalText,
  dutyTel3: optionalText,
  dutyEmcls: optionalText,
  dutyEmclsName: optionalText,
  wgs84Lat: optionalNumber,
  wgs84Lon: optionalNumber,
});

export interface HospitalRow {
  publicId: string;
  name: string;
  address?: string;
  erPhone?: string;
  mainPhone?: string;
  lat: number;
  lng: number;
  emclsCode?: string;
  grade: number;
}

export interface ParsedHospitals {
  hospitals: HospitalRow[];
  noCoords: string[];
}

export function parseHospitals(items: unknown[]): ParsedHospitals {
  const result: ParsedHospitals = { hospitals: [], noCoords: [] };
  for (const item of items) {
    const parsed = listItemSchema.safeParse(item);
    if (!parsed.success) continue;
    const { data } = parsed;
    // hospital.lat·lng는 비울 수 없다. 좌표 없는 병원은 저장하지 않으니 추천에도 나오지 않는다 (SFR-088).
    if (!isInKorea(data.wgs84Lat, data.wgs84Lon)) {
      result.noCoords.push(data.hpid);
      continue;
    }
    result.hospitals.push({
      publicId: data.hpid,
      name: data.dutyName.slice(0, MAX_NAME_LENGTH),
      address: data.dutyAddr,
      erPhone: data.dutyTel3,
      mainPhone: data.dutyTel1,
      lat: data.wgs84Lat as number,
      lng: data.wgs84Lon as number,
      emclsCode: data.dutyEmcls,
      grade: EMCLS_TO_GRADE[data.dutyEmclsName ?? ''] ?? DEFAULT_GRADE,
    });
  }
  result.hospitals = lastByKey(result.hospitals, (hospital) => hospital.publicId);
  return result;
}

// '내과,외과' → ['내과', '외과']
export function parseDepartments(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

async function saveRegion(
  pool: pg.Pool,
  region: string,
  startedAt: Date,
  { hospitals, noCoords }: ParsedHospitals,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    // 입구 좌표·계정 상태처럼 우리가 관리하는 컬럼은 건드리지 않는다.
    await client.query(
      `INSERT INTO hospital
         (public_id, name, address, er_phone, main_phone, lat, lng, emcls_code, grade)
       SELECT x."publicId", x.name, x.address, x."erPhone", x."mainPhone",
              x.lat, x.lng, x."emclsCode", x.grade
         FROM jsonb_to_recordset($1::jsonb) AS x(
                "publicId" varchar, name varchar, address text, "erPhone" varchar,
                "mainPhone" varchar, lat numeric, lng numeric, "emclsCode" varchar, grade smallint)
       ON CONFLICT (public_id) DO UPDATE SET
         name = excluded.name, address = excluded.address,
         er_phone = excluded.er_phone, main_phone = excluded.main_phone,
         lat = excluded.lat, lng = excluded.lng,
         emcls_code = excluded.emcls_code, grade = excluded.grade`,
      [JSON.stringify(hospitals)],
    );
    await client.query(
      `INSERT INTO bed_anomaly_log (public_id, reason)
       SELECT id, 'no_coords' FROM unnest($1::varchar[]) AS id`,
      [noCoords],
    );
    await client.query(
      `INSERT INTO collect_log (kind, region, started_at, finished_at, success, hospital_count)
       VALUES ('hospitals', $1, $2, now(), true, $3)`,
      [region, startedAt, hospitals.length],
    );
  });
}

export interface HospitalCollectDeps {
  pool: pg.Pool;
  fetchItems: FetchItems;
  quota: ApiQuota;
  regions: string[];
  logger: Logger;
}

export async function runHospitalCollect(deps: HospitalCollectDeps): Promise<void> {
  const { pool, fetchItems, quota, regions, logger } = deps;
  if (await quota.isExhausted()) return;

  const signal = AbortSignal.timeout(DEADLINE_MS);
  const publicIds: string[] = [];
  let quotaReached = false;
  const shouldStop = (): boolean => signal.aborted || quotaReached;

  await runPool(regions, CONCURRENT_REGIONS, shouldStop, async (region) => {
    const startedAt = new Date();
    try {
      const items = await fetchItems(LIST_OPERATION, { Q0: region }, signal);
      if (items.length === 0) throw new CollectError('EMPTY_REGION');
      const parsed = parseHospitals(items);
      await saveRegion(pool, region, startedAt, parsed);
      publicIds.push(...parsed.hospitals.map((hospital) => hospital.publicId));
    } catch (err) {
      const code = await recordFailure(pool, logger, 'hospitals', region, startedAt, err);
      if (code === 'QUOTA_EXCEEDED') quotaReached = true;
    }
  });

  // 진료과는 병원마다 따로 조회해야 한다. 실패한 병원은 이전 값을 유지하고 다음 날 다시 받는다.
  let failed = 0;
  await runPool(publicIds, CONCURRENT_HOSPITALS, shouldStop, async (publicId) => {
    try {
      const [item] = await fetchItems(BASIC_OPERATION, { HPID: publicId }, signal);
      const departments = parseDepartments((item as { dgidIdName?: unknown })?.dgidIdName);
      if (departments.length === 0) return;
      await pool.query('UPDATE hospital SET departments = $2 WHERE public_id = $1', [
        publicId,
        departments,
      ]);
    } catch (err) {
      if (err instanceof CollectError && err.code === 'QUOTA_EXCEEDED') quotaReached = true;
      failed += 1;
    }
  });

  await quota.save();
  logger.info(
    { hospitals: publicIds.length, departmentFailures: failed },
    '병원 기본정보 수집 종료',
  );
}
