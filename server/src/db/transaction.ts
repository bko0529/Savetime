// 여러 SQL을 한 묶음으로 실행한다. 중간에 실패하면 전부 취소된다.
import type pg from 'pg';

export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // 취소까지 실패해도 처음 오류를 알려야 원인을 찾을 수 있다.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
