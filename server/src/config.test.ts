// 환경 변수 읽기 (배포 리허설에서 찾은 문제): docker compose 가 '키=   # 설명' 의 설명을 값으로 넣는 경우를 막는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' };

test('값이 #로 시작하면(빈 값 뒤 설명이 들어감) 켜지지 않고, 이름만 알려 준다', () => {
  const comment = '# 무작위 32바이트(base64) 이상. 두 서버가 같은 값';
  assert.throws(
    () => loadConfig({ ...base, JWT_SECRET: comment, KAKAO_REST_API_KEY: '# 앱 서버만' }),
    (err: Error) =>
      /JWT_SECRET, KAKAO_REST_API_KEY/.test(err.message) && !err.message.includes('무작위'),
  );
});

test('빈 값·보통 값은 그대로 읽는다', () => {
  const config = loadConfig({ ...base, JWT_SECRET: 'a'.repeat(32), KAKAO_REST_API_KEY: '' });
  assert.equal(config.JWT_SECRET, 'a'.repeat(32));
  assert.equal(config.KAKAO_REST_API_KEY, '');
});

test('관리자 로그인 유지 시간: 비우면 15분, 값을 주면 그 값(최대 480분)', () => {
  assert.equal(loadConfig({ ...base }).ADMIN_ACCESS_MINUTES, 15);
  assert.equal(loadConfig({ ...base, ADMIN_ACCESS_MINUTES: '' }).ADMIN_ACCESS_MINUTES, 15);
  assert.equal(loadConfig({ ...base, ADMIN_ACCESS_MINUTES: '240' }).ADMIN_ACCESS_MINUTES, 240);
  assert.throws(() => loadConfig({ ...base, ADMIN_ACCESS_MINUTES: '1000' }));
});
