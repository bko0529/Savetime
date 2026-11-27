/**
 * 저장한 구급활동일지를 이 휴대폰에 7일만 보관한다 (expo-sqlite, DAR-015).
 * - 서버로는 보내지 않는다. 일지 초안은 서버가 이송 종료 후 10분만 주므로, 그 뒤에는 이 휴대폰 저장본을 쓴다
 * - 환자 성명 칸은 저장하지 않는다 (LogData 에 없음, SER-012)
 * - 열 때마다 7일 지난 것을 지운다
 */
import * as SQLite from 'expo-sqlite';
import type { LogData } from './form';

export const KEEP_MS = 7 * 24 * 60 * 60_000;
export type SavedJournal = { id: string; savedAt: number; data: LogData };

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
function db() {
  dbPromise ??= (async () => {
    const d = await SQLite.openDatabaseAsync('savetime.db');
    await d.execAsync(
      'CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY NOT NULL, saved_at INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    return d;
  })();
  return dbPromise;
}

export async function purgeOld(now = Date.now()) {
  await (await db()).runAsync('DELETE FROM journal WHERE saved_at < ?', now - KEEP_MS);
}

export async function saveJournal(id: string, data: LogData, now = Date.now()) {
  await (
    await db()
  ).runAsync(
    'INSERT INTO journal (id, saved_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET saved_at = excluded.saved_at, data = excluded.data',
    id,
    now,
    JSON.stringify(data),
  );
}

export async function listJournals(now = Date.now()): Promise<SavedJournal[]> {
  await purgeOld(now);
  const rows = await (
    await db()
  ).getAllAsync<{ id: string; saved_at: number; data: string }>(
    'SELECT id, saved_at, data FROM journal ORDER BY saved_at DESC',
  );
  return rows.map((r) => ({ id: r.id, savedAt: r.saved_at, data: JSON.parse(r.data) as LogData }));
}

export async function getJournal(id: string, now = Date.now()): Promise<SavedJournal | null> {
  await purgeOld(now);
  const r = await (
    await db()
  ).getFirstAsync<{ id: string; saved_at: number; data: string }>(
    'SELECT id, saved_at, data FROM journal WHERE id = ?',
    id,
  );
  return r ? { id: r.id, savedAt: r.saved_at, data: JSON.parse(r.data) as LogData } : null;
}
