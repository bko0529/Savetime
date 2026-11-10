// SFR-143 나만 보는 한 줄 메모 인수 기준을 임시 DB로 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import type { AuthContext } from '../auth/session.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const appFor = (ctx: AuthContext) =>
  createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });

async function login(ctx: AuthContext, loginId: string): Promise<string> {
  const res = await request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  return res.body.tokens.accessToken;
}

const putMemo = (ctx: AuthContext, token: string, target: string | number, memo: unknown) =>
  request(appFor(ctx))
    .put(`/api/v1/memos/${target}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ memo });

// '목록에서 초대'에서 그 대원 칸에 보이는 메모
async function memoInList(ctx: AuthContext, token: string, targetId: string) {
  const res = await request(appFor(ctx))
    .get('/api/v1/paramedics/on-duty')
    .query({ q: '김' })
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  return res.body.items.find((i: { paramedicId: number }) => i.paramedicId === Number(targetId))
    ?.myMemo;
}

async function otherAgencyParamedic(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `WITH a AS (INSERT INTO agency (code, name, region) VALUES ('OTHER-01', '다른소방서', '서울') RETURNING id)
     INSERT INTO paramedic (login_id, password_hash, name, rank, agency_id, safety_center, employee_no, status)
     SELECT 'far01', 'x', '김먼곳', '소방교', a.id, '다른센터', 'far01', 'approved' FROM a RETURNING id`,
  );
  return rows[0].id;
}

test('김도윤이 이하준에게 남긴 메모는 김도윤 목록에만 보이고 이서준 목록에는 안 보인다 (SFR-143 인수 기준)', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool, { loginId: 'kim01' });
    const ha = await addParamedic(ctx.pool, { loginId: 'ha01' });
    await addParamedic(ctx.pool, { loginId: 'seo01' });
    const kim = await login(ctx, 'kim01');
    const seo = await login(ctx, 'seo01');

    assert.equal((await putMemo(ctx, kim, ha, '3센터 운전 담당')).status, 204);
    assert.equal(await memoInList(ctx, kim, ha), '3센터 운전 담당');
    assert.equal(await memoInList(ctx, seo, ha), null);
  });
});

test('다시 쓰면 덮어쓰고, 빈 글이면 지운다. 앞뒤 공백은 뺀다', async () => {
  await withAuthContext(async (ctx) => {
    await addParamedic(ctx.pool, { loginId: 'kim01' });
    const ha = await addParamedic(ctx.pool, { loginId: 'ha01' });
    const kim = await login(ctx, 'kim01');

    await putMemo(ctx, kim, ha, '3센터 운전 담당');
    await putMemo(ctx, kim, ha, '  야간 근무  ');
    assert.equal(await memoInList(ctx, kim, ha), '야간 근무');
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM paramedic_memo');
    assert.equal(rows[0].n, 1);

    assert.equal((await putMemo(ctx, kim, ha, '   ')).status, 204);
    assert.equal(await memoInList(ctx, kim, ha), null);
    const { rows: left } = await ctx.pool.query('SELECT count(*)::int AS n FROM paramedic_memo');
    assert.equal(left[0].n, 0);
  });
});

test('21자 이상·글 아님은 400, 나 자신·없는 대원·다른 소방서·승인 전 대원은 404, 로그인 없으면 401', async () => {
  await withAuthContext(async (ctx) => {
    const kimId = await addParamedic(ctx.pool, { loginId: 'kim01' });
    const ha = await addParamedic(ctx.pool, { loginId: 'ha01' });
    const pending = await addParamedic(ctx.pool, { loginId: 'new01', status: 'pending' });
    const far = await otherAgencyParamedic(ctx.pool);
    const kim = await login(ctx, 'kim01');

    assert.equal((await putMemo(ctx, kim, ha, '가'.repeat(21))).status, 400);
    assert.equal((await putMemo(ctx, kim, ha, 3)).status, 400);
    assert.equal((await putMemo(ctx, kim, ha, '가'.repeat(20))).status, 204);
    for (const target of [kimId, '999999', far, pending]) {
      const res = await putMemo(ctx, kim, target, '메모');
      assert.equal(res.status, 404, String(target));
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }
    const anonymous = await request(appFor(ctx)).put(`/api/v1/memos/${ha}`).send({ memo: '메모' });
    assert.equal(anonymous.status, 401);
  });
});
