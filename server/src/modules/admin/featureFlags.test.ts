// 관리자 기능 토글 (QUR-013, SFR-091)을 임시 DB로 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { withAuthContext } from '../../testing/auth.js';
import { WEB_ORIGIN } from '../../testing/hospitalWeb.js';
import type { AuthContext } from '../auth/session.js';
import { signAdminAccessToken } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

async function harness(ctx: AuthContext) {
  const app = createApp({
    logger,
    healthChecks: { db: ok, redis: ok },
    admin: {
      pool: ctx.pool,
      redis: ctx.redis,
      jwtKey: ctx.jwtKey,
      sessionHours: 14,
      allowedOrigins: [WEB_ORIGIN],
    },
  });
  const { rows } = await ctx.pool.query<{ id: string }>(
    "INSERT INTO admin (login_id, password_hash, name) VALUES ('kim', 'x', '김관리') RETURNING id",
  );
  const token = await signAdminAccessToken(ctx.jwtKey, rows[0].id);
  const call = (method: 'get' | 'put', auth = true) => {
    const r = request(app)[method]('/api/v1/admin/feature-flags').set('Origin', WEB_ORIGIN);
    return auth ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  return { call, app };
}

const audit = async (ctx: AuthContext) =>
  (
    await ctx.pool.query<{ action: string; target_type: string; name: string }>(
      "SELECT action, target_type, detail->>'targetName' AS name FROM admin_audit_log ORDER BY id",
    )
  ).rows;

test('기능 토글을 보고 바꾸면 작업 이력에 남고, 같은 값이면 이력이 늘지 않는다 (QUR-013, SFR-091)', async () => {
  await withAuthContext(async (ctx) => {
    const { call } = await harness(ctx);
    // 기본값: AI 일지 정리 꺼짐, 병원 등급 선택 켜짐
    assert.deepEqual((await call('get')).body, { journalAi: false, hospitalGrade: true });

    const on = await call('put').send({ journalAi: true });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { journalAi: true, hospitalGrade: true });
    const { rows } = await ctx.pool.query(
      "SELECT enabled, updated_by IS NOT NULL AS by FROM feature_flag WHERE key = 'journal_ai'",
    );
    assert.deepEqual(rows[0], { enabled: true, by: true });

    // 같은 값을 또 보내도 이력은 1줄
    await call('put').send({ journalAi: true });
    // 둘을 한 번에: 등급 끄기만 실제로 바뀐다
    const both = await call('put').send({ journalAi: true, hospitalGrade: false });
    assert.deepEqual(both.body, { journalAi: true, hospitalGrade: false });
    assert.deepEqual(await audit(ctx), [
      { action: 'enable_feature', target_type: 'feature_flag', name: 'AI 일지 정리' },
      { action: 'disable_feature', target_type: 'feature_flag', name: '병원 등급 선택' },
    ]);
  });
});

test('빈 요청·모르는 칸·글 값은 400, 관리자가 아니면 401 (SER-010)', async () => {
  await withAuthContext(async (ctx) => {
    const { call } = await harness(ctx);
    assert.equal((await call('put').send({})).status, 400);
    assert.equal((await call('put').send({ voiceInput: true })).status, 400);
    assert.equal((await call('put').send({ journalAi: 'yes' })).status, 400);
    assert.equal((await call('get', false)).status, 401);
    assert.equal((await call('put', false).send({ journalAi: true })).status, 401);
    // 아무것도 바뀌지 않았다
    assert.deepEqual((await call('get')).body, { journalAi: false, hospitalGrade: true });
    assert.deepEqual(await audit(ctx), []);
  });
});

test('표에 행이 없던 기능도 켤 수 있다', async () => {
  await withAuthContext(async (ctx) => {
    const { call } = await harness(ctx);
    await ctx.pool.query("DELETE FROM feature_flag WHERE key = 'journal_ai'");
    assert.equal((await call('get')).body.journalAi, false);
    assert.deepEqual((await call('put').send({ journalAi: true })).body, {
      journalAi: true,
      hospitalGrade: true,
    });
  });
});
