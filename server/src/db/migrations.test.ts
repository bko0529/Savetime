// 마이그레이션 결과가 schema.sql과 같은지 임시 DB에서 비교한다. 개발 DB는 건드리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { withTempDatabase } from '../testing/services.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const SCHEMA_FILE = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

async function migrate(url: string, direction: 'up' | 'down', count?: number): Promise<void> {
  await runner({
    databaseUrl: url,
    dir: MIGRATIONS_DIR,
    direction,
    count,
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}

// 테이블·컬럼·제약·인덱스를 문자열로 뽑아 정렬한다. 컬럼 순서는 달라도 괜찮다.
async function describeSchema(url: string): Promise<string[]> {
  const columns = await query<{ line: string }>(
    url,
    `SELECT concat_ws(' ', table_name, column_name, udt_name, is_nullable, column_default) AS line
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'pgmigrations'`,
  );
  const constraints = await query<{ line: string }>(
    url,
    `SELECT concat_ws(' ', c.conrelid::regclass::text, pg_get_constraintdef(c.oid)) AS line
       FROM pg_constraint c
      WHERE c.connamespace = 'public'::regnamespace AND c.conrelid <> 'pgmigrations'::regclass`,
  );
  const indexes = await query<{ line: string }>(
    url,
    `SELECT indexdef AS line FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`,
  );
  return [...columns, ...constraints, ...indexes].map((row) => row.line).sort();
}

test('마이그레이션을 끝까지 적용하면 schema.sql과 구조가 같다', async () => {
  await withTempDatabase(async (migratedUrl) => {
    await withTempDatabase(async (schemaUrl) => {
      await migrate(migratedUrl, 'up');

      const client = new pg.Client({ connectionString: schemaUrl });
      await client.connect();
      await client.query(await readFile(SCHEMA_FILE, 'utf8'));
      await client.query('CREATE TABLE pgmigrations (id serial PRIMARY KEY)');
      await client.end();

      assert.deepEqual(await describeSchema(migratedUrl), await describeSchema(schemaUrl));
    });
  });
});

test('마이그레이션을 두 번 실행해도 아무 일도 일어나지 않는다', async () => {
  await withTempDatabase(async (url) => {
    await migrate(url, 'up');
    await migrate(url, 'up');
    const rows = await query<{ count: string }>(url, 'SELECT count(*) FROM pgmigrations');
    assert.equal(rows[0].count, '2');
  });
});

test('0002는 되돌렸다가 다시 적용할 수 있다', async () => {
  await withTempDatabase(async (url) => {
    await migrate(url, 'up');
    await migrate(url, 'down', 1);
    const tables = await query(url, `SELECT 1 FROM pg_tables WHERE tablename = 'collect_log'`);
    assert.equal(tables.length, 0);
    await migrate(url, 'up');
  });
});

test('기본 데이터는 마이그레이션으로도 들어간다', async () => {
  await withTempDatabase(async (url) => {
    await migrate(url, 'up');
    const rows = await query<{ key: string }>(url, 'SELECT key FROM feature_flag ORDER BY key');
    assert.deepEqual(
      rows.map((row) => row.key),
      ['hospital_grade', 'journal_ai', 'voice_input'],
    );
  });
});
