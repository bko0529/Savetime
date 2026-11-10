// GET /config (QUR-013 기능 토글, SFR-142 앱 최소 버전)를 임시 DB로 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { withAuthContext } from '../../testing/auth.js';
import { loadConfig } from '../../config.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

test('로그인 없이 기능 토글·앱 최소 버전·서버 시각을 준다 (SFR-142 인수 기준의 서버 쪽)', async () => {
  await withAuthContext(async (ctx) => {
    const app = createApp({
      logger,
      healthChecks: { db: ok, redis: ok },
      auth: ctx,
      minAppVersion: '1.3.0',
    });
    const res = await request(app).get('/api/v1/config');
    assert.equal(res.status, 200);
    // 기본 데이터: AI 일지 정리는 꺼짐, 병원 등급 선택은 켜짐 (schema.sql)
    assert.deepEqual(res.body.featureFlags, { journalAi: false, hospitalGrade: true });
    // 앱은 이 값과 자기 버전(예: 1.2.0)을 비교해 낮으면 '업데이트가 필요해요'만 보여 준다
    assert.equal(res.body.minAppVersion, '1.3.0');
    assert.ok(Math.abs(Date.parse(res.body.serverNow) - Date.now()) < 60_000);

    // 관리자가 토글을 바꾸면 다음 읽기부터 바로 반영된다 (앱은 1분마다 읽음)
    await ctx.pool.query("UPDATE feature_flag SET enabled = true WHERE key = 'journal_ai'");
    await ctx.pool.query("DELETE FROM feature_flag WHERE key = 'hospital_grade'");
    const after = await request(app).get('/api/v1/config');
    // 표에 없는 기능은 꺼진 것으로 본다
    assert.deepEqual(after.body.featureFlags, { journalAi: true, hospitalGrade: false });
  });
});

test('MIN_APP_VERSION: 비우면 1.0.0, 숫자 3개 모양이 아니면 서버가 켜지지 않는다', () => {
  const base = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' };
  assert.equal(loadConfig({ ...base }).MIN_APP_VERSION, '1.0.0');
  assert.equal(loadConfig({ ...base, MIN_APP_VERSION: '' }).MIN_APP_VERSION, '1.0.0');
  assert.equal(loadConfig({ ...base, MIN_APP_VERSION: '1.12.3' }).MIN_APP_VERSION, '1.12.3');
  assert.throws(() => loadConfig({ ...base, MIN_APP_VERSION: 'v1.2' }), /MIN_APP_VERSION/);
});
