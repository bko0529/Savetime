import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AppError, errorHandler } from './http/errors.js';

const logger = pino({ level: 'silent' });

// async 처리기에서 던진 오류도 Express 5가 오류 처리기로 넘기는지 함께 확인한다
function appThatThrows(err: Error): express.Express {
  const app = express();
  app.get('/x', async () => {
    throw err;
  });
  app.use(errorHandler(logger));
  return app;
}

const ok = async () => 'ok';
const fail = async () => {
  throw new Error('연결 실패 password=비밀');
};

test('/health: DB·Redis가 모두 정상이면 200', async () => {
  const app = createApp({ logger, healthChecks: { db: ok, redis: ok } });
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', checks: { db: 'ok', redis: 'ok' } });
});

test('/health: 하나라도 실패하면 503이고 내부 오류 내용은 밖으로 나가지 않는다', async () => {
  const app = createApp({ logger, healthChecks: { db: fail, redis: ok } });
  const res = await request(app).get('/health');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { status: 'error', checks: { db: 'error', redis: 'ok' } });
  assert.ok(!res.text.includes('password'));
});

test('/health: 응답이 없는 의존성은 시간 제한으로 실패 처리한다', { timeout: 5000 }, async () => {
  const hang = () => new Promise(() => {});
  const app = createApp({ logger, healthChecks: { db: hang, redis: ok } });
  const res = await request(app).get('/health');
  assert.equal(res.status, 503);
  assert.equal(res.body.checks.db, 'error');
});

test('모든 응답에 X-Server-Now가 붙는다 (오류 응답 포함)', async () => {
  const app = createApp({ logger, healthChecks: { db: ok } });
  for (const path of ['/health', '/없는-주소']) {
    const res = await request(app).get(encodeURI(path));
    const value = res.headers['x-server-now'];
    assert.ok(value, path);
    assert.equal(new Date(value).toISOString(), value);
  }
});

test('없는 주소는 공통 오류 형식의 404', async () => {
  const app = createApp({ logger, healthChecks: {} });
  const res = await request(app).get('/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
  assert.equal(typeof res.body.error.message, 'string');
});

test('깨진 JSON은 400 VALIDATION_FAILED', async () => {
  const app = createApp({ logger, healthChecks: {} });
  const res = await request(app)
    .post('/nope')
    .set('Content-Type', 'application/json')
    .send('{"a":');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
});

test('AppError는 상태 코드와 details를 그대로 내보낸다', async () => {
  const app = appThatThrows(
    new AppError(409, 'VERSION_CONFLICT', '최신 상태가 아니에요', { current: 2 }),
  );
  const res = await request(app).get('/x');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, {
    error: { code: 'VERSION_CONFLICT', message: '최신 상태가 아니에요', details: { current: 2 } },
  });
});

test('예상 못 한 오류는 500으로 바꾸고 내용을 숨긴다', async () => {
  const res = await request(appThatThrows(new Error('SELECT * FROM 비밀 테이블'))).get('/x');
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  assert.ok(!res.text.includes('비밀'));
});

test('환경 변수가 빠지면 이름만 알려 주고 값은 보여 주지 않는다', () => {
  assert.throws(
    () => loadConfig({ REDIS_URL: 'redis://user:secret@host' }),
    (err: Error) => err.message.includes('DATABASE_URL') && !err.message.includes('secret'),
  );
});

test('환경 변수 기본값과 숫자 변환', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', PORT: '5000' });
  assert.equal(config.PORT, 5000);
  assert.equal(config.NODE_ENV, 'development');
});
