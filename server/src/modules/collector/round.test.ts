// SFR-023 인수 기준을 임시 DB에서 그대로 확인한다. 공공 API는 호출하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pino } from 'pino';
import { withTempDatabase } from '../../testing/services.js';
import type { BedRow } from './parseBeds.js';
import { CollectError, type FetchBeds } from './publicApi.js';
import { ALL_REGIONS, runCollectRound } from './round.js';

const logger = pino({ level: 'silent' });
const SCHEMA_FILE = fileURLToPath(new URL('../../../db/schema.sql', import.meta.url));

function bedsFor(region: string, erAvail: number, sourceTime: string): BedRow[] {
  return [{ publicId: region, erAvail, erTotal: 20, sourceTime, raw: { region }, excluded: false }];
}

async function withPool(use: (pool: pg.Pool) => Promise<void>): Promise<void> {
  await withTempDatabase(async (url) => {
    const pool = new pg.Pool({ connectionString: url });
    // 테스트 끝에 임시 DB를 지울 때 닫히는 중이던 연결이 끊겨도 실패로 보지 않는다
    pool.on('error', () => {});
    try {
      await pool.query(await readFile(SCHEMA_FILE, 'utf8'));
      // 시·도마다 병원 1곳: 기본정보 수집(S1 9번) 대신 직접 넣는다
      await pool.query(
        `INSERT INTO hospital (public_id, name, lat, lng)
         SELECT region, region, 36.5, 127.5 FROM unnest($1::text[]) AS region`,
        [ALL_REGIONS],
      );
      await use(pool);
    } finally {
      await pool.end();
    }
  });
}

async function erAvail(pool: pg.Pool, region: string): Promise<number | undefined> {
  const { rows } = await pool.query<{ er_avail: number }>(
    `SELECT c.er_avail FROM bed_current c JOIN hospital h ON h.id = c.hospital_id
      WHERE h.public_id = $1`,
    [region],
  );
  return rows[0]?.er_avail;
}

test('17개 시·도를 수집하면 시·도별 성공 기록이 17건 남는다', async () => {
  await withPool(async (pool) => {
    const fetchBeds: FetchBeds = async (region) => bedsFor(region, 5, '2026-11-02T14:03:00+09:00');
    const result = await runCollectRound({ pool, fetchBeds, regions: ALL_REGIONS, logger });

    assert.deepEqual(result, { succeeded: 17, failed: 0, notStarted: 0 });
    const { rows } = await pool.query(
      `SELECT source_time, hospital_count FROM collect_log WHERE success`,
    );
    assert.equal(rows.length, 17);
    assert.equal(rows[0].source_time.toISOString(), '2026-11-02T05:03:00.000Z');
    assert.equal(rows[0].hospital_count, 1);
    const history = await pool.query('SELECT count(*) FROM bed_history');
    assert.equal(history.rows[0].count, '17');
  });
});

test('세종만 실패하면 나머지만 갱신되고 세종은 이전 값과 기준 시각을 유지한다', async () => {
  await withPool(async (pool) => {
    const first: FetchBeds = async (region) => bedsFor(region, 1, '2026-11-02T14:00:00+09:00');
    await runCollectRound({ pool, fetchBeds: first, regions: ALL_REGIONS, logger });

    const second: FetchBeds = async (region) => {
      if (region === '세종특별자치시') throw new CollectError('HTTP_500');
      return bedsFor(region, 2, '2026-11-02T14:03:00+09:00');
    };
    const result = await runCollectRound({ pool, fetchBeds: second, regions: ALL_REGIONS, logger });

    assert.deepEqual(result, { succeeded: 16, failed: 1, notStarted: 0 });
    assert.equal(await erAvail(pool, '세종특별자치시'), 1);
    assert.equal(await erAvail(pool, '충청남도'), 2);
    const { rows } = await pool.query(
      `SELECT c.source_time FROM bed_current c JOIN hospital h ON h.id = c.hospital_id
        WHERE h.public_id = '세종특별자치시'`,
    );
    assert.equal(rows[0].source_time.toISOString(), '2026-11-02T05:00:00.000Z');
    const failed = await pool.query(`SELECT region, error_code FROM collect_log WHERE NOT success`);
    assert.deepEqual(failed.rows, [{ region: '세종특별자치시', error_code: 'HTTP_500' }]);
  });
});

test('동시에 4곳까지만 수집한다', async () => {
  await withPool(async (pool) => {
    let running = 0;
    let maxRunning = 0;
    const fetchBeds: FetchBeds = async (region) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(20);
      running -= 1;
      return bedsFor(region, 3, '2026-11-02T14:03:00+09:00');
    };
    await runCollectRound({ pool, fetchBeds, regions: ALL_REGIONS, logger });
    assert.equal(maxRunning, 4);
  });
});

test('마감 안에 못 끝낸 시·도는 다음 회차에 먼저 수집한다', async () => {
  await withPool(async (pool) => {
    const slow: FetchBeds = async (region, signal) => {
      await sleep(40);
      if (signal.aborted) throw new CollectError('DEADLINE');
      return bedsFor(region, 1, '2026-11-02T14:00:00+09:00');
    };
    const first = await runCollectRound({
      pool,
      fetchBeds: slow,
      regions: ALL_REGIONS,
      logger,
      deadlineMs: 60,
    });
    assert.ok(first.notStarted > 0, `시작 못 한 시·도 ${first.notStarted}`);

    const done = await pool.query<{ region: string }>(
      `SELECT DISTINCT region FROM collect_log WHERE success`,
    );
    const finished = new Set(done.rows.map((row) => row.region));

    const order: string[] = [];
    const record: FetchBeds = async (region) => {
      order.push(region);
      return bedsFor(region, 2, '2026-11-02T14:03:00+09:00');
    };
    await runCollectRound({ pool, fetchBeds: record, regions: ALL_REGIONS, logger });

    const firstFinishedAt = order.findIndex((region) => finished.has(region));
    assert.equal(firstFinishedAt, 17 - finished.size);
  });
});

test('hospital에 없는 병원은 건너뛰고 수집은 성공으로 남긴다', async () => {
  await withPool(async (pool) => {
    const fetchBeds: FetchBeds = async (region) => [
      ...bedsFor(region, 4, '2026-11-02T14:03:00+09:00'),
      ...bedsFor('모르는병원', 9, '2026-11-02T14:03:00+09:00'),
    ];
    await runCollectRound({ pool, fetchBeds, regions: ['충청남도'], logger });

    assert.equal(await erAvail(pool, '충청남도'), 4);
    const { rows } = await pool.query('SELECT hospital_count FROM collect_log');
    assert.equal(rows[0].hospital_count, 1);
  });
});

test('이상치는 처음 생길 때 1건만 남기고, 값이 돌아오면 제외를 푼다', async () => {
  await withPool(async (pool) => {
    let excluded = true;
    const fetchBeds: FetchBeds = async (region) => [
      {
        publicId: region,
        erAvail: excluded ? 15 : 5,
        erTotal: 10,
        sourceTime: '2026-11-02T14:03:00+09:00',
        raw: {},
        excluded,
      },
    ];
    const round = (): Promise<unknown> =>
      runCollectRound({ pool, fetchBeds, regions: ['충청남도'], logger });
    const state = async (): Promise<boolean> =>
      (await pool.query('SELECT excluded FROM bed_current')).rows[0].excluded;

    await round();
    await round();
    assert.equal(await state(), true);
    const logs = await pool.query('SELECT public_id, reason, detail FROM bed_anomaly_log');
    assert.deepEqual(logs.rows, [
      {
        public_id: '충청남도',
        reason: 'avail_over_total',
        detail: { er: [15, 10], icu: [null, null], or: [null, null] },
      },
    ]);

    excluded = false;
    await round();
    assert.equal(await state(), false);
  });
});

test('0건이 오면 시·도 이름 오류일 수 있어 실패로 기록한다', async () => {
  await withPool(async (pool) => {
    const fetchBeds: FetchBeds = async () => [];
    const result = await runCollectRound({ pool, fetchBeds, regions: ['강원도'], logger });

    assert.deepEqual(result, { succeeded: 0, failed: 1, notStarted: 0 });
    const { rows } = await pool.query('SELECT error_code FROM collect_log');
    assert.equal(rows[0].error_code, 'EMPTY_REGION');
  });
});

test('저장에 실패하면 병상은 그대로 두고 SAVE_FAILED로 기록한다', async () => {
  await withPool(async (pool) => {
    const fetchBeds: FetchBeds = async (region) => bedsFor(region, 4, '시각이 아닌 값');
    const result = await runCollectRound({ pool, fetchBeds, regions: ['충청남도'], logger });

    assert.deepEqual(result, { succeeded: 0, failed: 1, notStarted: 0 });
    assert.equal(await erAvail(pool, '충청남도'), undefined);
    const { rows } = await pool.query('SELECT error_code FROM collect_log');
    assert.equal(rows[0].error_code, 'SAVE_FAILED');
  });
});
