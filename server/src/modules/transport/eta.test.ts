// SFR-072·073 예상 이동시간을 가짜 길찾기 응답과 실제 Redis로 확인한다. 카카오는 부르지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { TEST_REDIS_URL } from '../../testing/services.js';
import { createEtaLookup } from './eta.js';

const logger = pino({ level: 'silent' });
const origin = { lat: 36.8, lng: 127.1 };
const hospitals = [
  { id: '1', lat: 36.81, lng: 127.11 },
  { id: '2', lat: 36.9, lng: 127.2 },
];

type Reply = { status?: number; body?: unknown } | Error;

function route(seconds: number, code = 0) {
  return { body: { routes: [{ result_code: code, summary: { duration: seconds } }] } };
}

async function withEta(
  replies: (url: URL) => Reply,
  use: (h: {
    lookup: ReturnType<typeof createEtaLookup>;
    calls: URL[];
    headers: Headers[];
    quota: { exhausted: boolean; taken: number };
  }) => Promise<void>,
): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, { keyPrefix: `t_${randomBytes(6).toString('hex')}:` });
  const calls: URL[] = [];
  const headers: Headers[] = [];
  const quota = { exhausted: false, taken: 0 };
  const fetchFn = (async (input: URL, init?: RequestInit) => {
    calls.push(input);
    headers.push(new Headers(init?.headers));
    const reply = replies(input);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as typeof fetch;
  try {
    await use({
      lookup: createEtaLookup({
        apiKey: 'test-key',
        redis,
        logger,
        fetchFn,
        quota: {
          take: async () => {
            quota.taken += 1;
          },
          isExhausted: async () => quota.exhausted,
          save: async () => {},
        },
      }),
      calls,
      headers,
      quota,
    });
  } finally {
    redis.disconnect();
  }
}

test('도로 기준 시간을 분으로 바꾸고, 카카오 형식(경도,위도)으로 부른다', async () => {
  await withEta(
    (url) => (url.searchParams.get('destination')?.startsWith('127.11') ? route(540) : route(1830)),
    async ({ lookup, calls, headers, quota }) => {
      const etas = await lookup(origin, hospitals);
      assert.deepEqual(Object.fromEntries(etas), { 1: 9, 2: 31 });
      assert.equal(
        calls[0].origin + calls[0].pathname,
        'https://apis-navi.kakaomobility.com/v1/directions',
      );
      assert.equal(calls[0].searchParams.get('origin'), '127.1,36.8');
      assert.equal(calls[0].searchParams.get('summary'), 'true');
      assert.equal(headers[0].get('Authorization'), 'KakaoAK test-key');
      assert.equal(quota.taken, 2);
    },
  );
});

test('같은 자리(약 100m 안)에서 다시 조회하면 길찾기를 다시 부르지 않는다', async () => {
  await withEta(
    () => route(600),
    async ({ lookup, calls }) => {
      await lookup(origin, hospitals);
      const again = await lookup({ lat: 36.8002, lng: 127.1003 }, hospitals);
      assert.equal(calls.length, 2);
      assert.deepEqual(Object.fromEntries(again), { 1: 10, 2: 10 });
    },
  );
});

test('실패한 병원은 빠지고(예상 이동시간 없음), 실패는 저장하지 않아 다음에 다시 부른다 (SFR-073)', async () => {
  let attempt = 0;
  await withEta(
    (url) => {
      const isFirst = url.searchParams.get('destination')?.startsWith('127.11');
      if (isFirst) return route(300);
      attempt += 1;
      return attempt === 1 ? { status: 500 } : route(900);
    },
    async ({ lookup, calls }) => {
      assert.deepEqual(Object.fromEntries(await lookup(origin, hospitals)), { 1: 5 });
      assert.deepEqual(Object.fromEntries(await lookup(origin, hospitals)), { 1: 5, 2: 15 });
      assert.equal(calls.length, 3);
    },
  );
});

test('경로 없음 코드·네트워크 오류·이상한 응답도 예외 없이 빠진다', async () => {
  for (const reply of [
    route(300, 104),
    new Error('network'),
    { body: { routes: [] } },
    { body: 'x' },
  ]) {
    await withEta(
      () => reply,
      async ({ lookup }) => {
        assert.equal((await lookup(origin, hospitals)).size, 0);
      },
    );
  }
});

test('오늘 무료량을 다 썼으면 부르지 않는다 (ASM-12)', async () => {
  await withEta(
    () => route(300),
    async ({ lookup, calls, quota }) => {
      quota.exhausted = true;
      assert.equal((await lookup(origin, hospitals)).size, 0);
      assert.equal(calls.length, 0);
    },
  );
});
