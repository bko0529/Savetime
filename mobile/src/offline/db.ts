/**
 * 이 휴대폰의 데이터베이스 하나 (expo-sqlite, 기술정의서 '오프라인 보관').
 * - journal: 저장한 구급활동일지 7일 (DAR-015)
 * - hospital_cache: 병원 목록 조회 결과, 지역별 최근 10건 (SFR-059)
 * - offline_queue: 통신 두절 중 기록 (SFR-099), 올리면 지움
 * 환자 이름·연락처는 어디에도 넣지 않는다 (SER-012)
 */
import * as SQLite from 'expo-sqlite';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
export function db() {
  dbPromise ??= (async () => {
    const d = await SQLite.openDatabaseAsync('savetime.db');
    await d.execAsync(
      [
        'CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY NOT NULL, saved_at INTEGER NOT NULL, data TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS hospital_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, region TEXT NOT NULL, saved_at INTEGER NOT NULL, data TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS offline_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)',
      ].join(';\n'),
    );
    return d;
  })();
  return dbPromise;
}

/** 테스트용 */
export function __resetDbForTest() {
  dbPromise = null;
}
