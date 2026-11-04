// SFR-086 활동 없음 2시간 자동 종료를 임시 DB와 실제 Redis로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { pino } from 'pino';
import { withAuthContext } from '../../testing/auth.js';
import { requestStates, scene } from '../../testing/transportScene.js';
import { endInactiveTransports } from './autoEnd.js';

const logger = pino({ level: 'silent' });

async function idleFor(pool: pg.Pool, id: string, interval: string) {
  await pool.query(`UPDATE transport SET last_activity_at = now() - $2::interval WHERE id = $1`, [
    id,
    interval,
  ]);
}

test('마지막 활동 후 2시간이 지나면 자동 종료(auto_inactive)로 취소하고 병원 요청을 닫는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await idleFor(ctx.pool, s.transportId, '2 hours 1 minute');

    const events = await endInactiveTransports(ctx.pool, logger);
    const { rows } = await ctx.pool.query(
      'SELECT status, cancel_reason, origin_lat FROM transport WHERE id = $1',
      [s.transportId],
    );
    assert.deepEqual(rows[0], {
      status: 'cancelled',
      cancel_reason: 'auto_inactive',
      origin_lat: null,
    });
    assert.deepEqual(
      (await requestStates(ctx.pool)).map((r) => r[1]),
      ['closed', 'closed', 'closed'],
    );
    const status = events.find((e) => e.name === 'transport.status')!;
    assert.equal(status.payload.reason, 'auto_inactive');
    assert.equal(events.filter((e) => e.name === 'request.changed').length, 3);
  });
});

test('2시간이 안 됐거나 이미 끝난 이송 건은 그대로 둔다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await idleFor(ctx.pool, s.transportId, '1 hour 59 minutes');
    assert.deepEqual(await endInactiveTransports(ctx.pool, logger), []);
    const { rows } = await ctx.pool.query('SELECT status FROM transport WHERE id = $1', [
      s.transportId,
    ]);
    assert.equal(rows[0].status, 'requesting');

    // 이미 도착한 건은 오래돼도 건드리지 않는다
    await ctx.pool.query(`UPDATE transport SET status = 'arrived' WHERE id = $1`, [s.transportId]);
    await idleFor(ctx.pool, s.transportId, '5 hours');
    assert.deepEqual(await endInactiveTransports(ctx.pool, logger), []);
  });
});
