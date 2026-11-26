// 관리자 토큰 유효 시간 (기본 15분, ADMIN_ACCESS_MINUTES 로 바꿀 수 있음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwt } from 'jose';
import { signAdminAccessToken } from './tokens.js';

const key = new Uint8Array(32).fill(7);

test('기본은 15분, 값을 주면 그만큼', async () => {
  const lifetime = (t: string) => {
    const p = decodeJwt(t);
    return (p.exp ?? 0) - (p.iat ?? 0);
  };
  assert.equal(lifetime(await signAdminAccessToken(key, '1')), 15 * 60);
  assert.equal(lifetime(await signAdminAccessToken(key, '1', 240)), 240 * 60);
});
