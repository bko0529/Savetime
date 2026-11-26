// QUR-014 인수 기준: 일부러 어긋난 데이터를 넣고 하루 점검이 찾아내는지 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { withAuthContext } from '../../testing/auth.js';
import { scene } from '../../testing/transportScene.js';
import { checkIntegrity, runIntegrityCheck } from './integrity.js';

const logger = pino({ level: 'silent' });

test('정상인 이송 건만 있으면 발견 0건이고 알림도 없다', async () => {
  await withAuthContext(async (ctx) => {
    await scene(ctx);
    assert.equal(await runIntegrityCheck(ctx.pool, logger), 0);
    const { rows } = await ctx.pool.query('SELECT 1 FROM admin_notification');
    assert.equal(rows.length, 0);
  });
});

test('어긋난 데이터를 종류별로 찾아내고 관리자 알림 1건(발견 건수)을 올린다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    const id = s.transportId;

    // ① 활동 없이 3시간 지난 진행 중 이송 건 (자동 종료가 멈춘 상황)
    await ctx.pool.query(
      `UPDATE transport SET last_activity_at = now() - interval '3 hours' WHERE id = $1`,
      [id],
    );
    // ② 한 병원은 확정됐는데 다른 병원 요청이 대기로 남음
    await ctx.pool.query(
      `UPDATE hospital_request SET status = 'confirmed'
        WHERE id = (SELECT hr.id FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
                     WHERE r.transport_id = $1 ORDER BY hr.id LIMIT 1)`,
      [id],
    );
    const found = await checkIntegrity(ctx.pool);
    assert.deepEqual(found.staleActive, [id]);
    assert.deepEqual(found.openAfterConfirm, [id]);
    assert.deepEqual(found.leftoverLocations, []);

    // ④ 끝난 이송 건에 원본 위치가 남음 (②·① 은 도착 처리로 사라짐: ① 은 진행 중만 보므로)
    await ctx.pool.query(`UPDATE transport SET status = 'arrived' WHERE id = $1`, [id]);
    await ctx.pool.query(
      `INSERT INTO location_point (transport_id, device_id, lat, lng, recorded_at)
       VALUES ($1, 'dev-1', 36.81, 127.11, now())`,
      [id],
    );
    const after = await checkIntegrity(ctx.pool);
    assert.deepEqual(after, { staleActive: [], openAfterConfirm: [id], leftoverLocations: [id] });

    assert.equal(await runIntegrityCheck(ctx.pool, logger), 2);
    const { rows } = await ctx.pool.query<{ ref_id: string }>(
      "SELECT ref_id FROM admin_notification WHERE kind = 'integrity'",
    );
    assert.deepEqual(
      rows.map((r) => Number(r.ref_id)),
      [2],
    );
  });
});

test('2시간을 막 넘긴 진행 중 건은 자동 종료가 곧 처리하므로 잡지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    const s = await scene(ctx);
    await ctx.pool.query(
      `UPDATE transport SET last_activity_at = now() - interval '2 hours 3 minutes' WHERE id = $1`,
      [s.transportId],
    );
    assert.deepEqual((await checkIntegrity(ctx.pool)).staleActive, []);
  });
});
