// SFR-009 주소 → 좌표를 가짜 카카오 응답으로 확인한다. 카카오는 부르지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, withAuthContext } from '../../testing/auth.js';
import { signAccessToken } from '../auth/tokens.js';
import { createGeocoder, GeocodeUnavailable, type Geocoder } from './geocode.js';

const ADDRESS = '충청남도 천안시 동남구 신부동';
const ok = async () => 'ok';

type Reply = { status?: number; body?: unknown } | Error;

function fakeKakao(replies: Record<'address' | 'keyword', Reply>) {
  const calls: URL[] = [];
  const fetchFn = (async (input: URL) => {
    calls.push(input);
    const reply = input.pathname.endsWith('keyword.json') ? replies.keyword : replies.address;
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as typeof fetch;
  let taken = 0;
  const geocoder = createGeocoder({
    apiKey: 'test-key',
    fetchFn,
    quota: { take: async () => void (taken += 1), save: async () => {} },
  });
  return { geocoder, calls, taken: () => taken };
}

const found = { body: { documents: [{ address_name: ADDRESS, x: '127.1532', y: '36.8174' }] } };
const none = { body: { documents: [] } };

test('주소로 찾으면 좌표를 숫자로 바꿔 준다 (카카오 x=경도, y=위도)', async () => {
  const { geocoder, calls, taken } = fakeKakao({ address: found, keyword: none });
  assert.deepEqual(await geocoder(ADDRESS), [
    { address: ADDRESS, location: { lat: 36.8174, lng: 127.1532 } },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('query'), ADDRESS);
  assert.equal(calls[0].searchParams.get('size'), '5');
  assert.equal(taken(), 1);
});

test('주소로 못 찾으면 장소 이름으로 한 번 더 찾는다', async () => {
  const station = {
    body: {
      documents: [
        {
          place_name: '천안역',
          address_name: '충남 천안시 동남구 대흥동 1',
          road_address_name: '충남 천안시 동남구 대흥로 239',
          x: '127.1464',
          y: '36.8101',
        },
      ],
    },
  };
  const { geocoder, calls } = fakeKakao({ address: none, keyword: station });
  assert.deepEqual(await geocoder('천안역'), [
    {
      address: '천안역 (충남 천안시 동남구 대흥로 239)',
      location: { lat: 36.8101, lng: 127.1464 },
    },
  ]);
  assert.equal(calls.length, 2);
});

test('대한민국 밖 좌표와 형식이 깨진 결과는 뺀다', async () => {
  const mixed = {
    body: {
      documents: [
        { address_name: '밖', x: '0', y: '0' },
        { address_name: '깨짐', x: 'abc' },
        { address_name: ADDRESS, x: '127.1', y: '36.8' },
      ],
    },
  };
  const { geocoder } = fakeKakao({ address: mixed, keyword: none });
  assert.deepEqual(
    (await geocoder(ADDRESS)).map((r) => r.address),
    [ADDRESS],
  );
});

test('카카오가 실패하거나 응답이 이상하면 GeocodeUnavailable이고, 오류에 주소가 없다', async () => {
  for (const reply of [{ status: 500 }, new Error(`fetch failed ${ADDRESS}`), { body: 'x' }]) {
    const { geocoder } = fakeKakao({ address: reply, keyword: none });
    await assert.rejects(geocoder(ADDRESS), (err: Error) => {
      return err instanceof GeocodeUnavailable && !String(err.message).includes('신부동');
    });
  }
});

async function withApi(
  geocoder: Geocoder | undefined,
  use: (get: (path: string) => request.Test, logs: string[]) => Promise<void>,
) {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      logs.push(String(chunk));
      done();
    },
  });
  const logger = pino({ level: 'debug' }, stream);
  await withAuthContext(async (auth) => {
    const app = createApp({ logger, healthChecks: { db: ok, redis: ok }, auth, geocoder });
    const paramedicId = await addParamedic(auth.pool);
    const token = await signAccessToken(auth.jwtKey, { paramedicId, sessionVersion: 1 });
    await use((path) => request(app).get(path).set('Authorization', `Bearer ${token}`), logs);
  });
}

const query = `/api/v1/geocode?address=${encodeURIComponent(ADDRESS)}`;

test('GET /geocode: 후보를 주고, 0건이면 404 ADDRESS_NOT_FOUND다', async () => {
  const result = [{ address: ADDRESS, location: { lat: 36.8, lng: 127.1 } }];
  await withApi(
    async () => result,
    async (get) => {
      const res = await get(query);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, result);
    },
  );
  await withApi(
    async () => [],
    async (get) => {
      const res = await get(query);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'ADDRESS_NOT_FOUND');
      assert.equal(res.body.error.message, '주소를 찾을 수 없습니다');
    },
  );
});

test('GET /geocode: 카카오 장애·키 없음은 503, 짧은 입력은 400이다', async () => {
  await withApi(
    async () => {
      throw new GeocodeUnavailable();
    },
    async (get) => {
      assert.equal((await get(query)).body.error.code, 'GEOCODE_UNAVAILABLE');
      const short = await get('/api/v1/geocode?address=a');
      assert.equal(short.status, 400);
      assert.deepEqual(short.body.error.details.fields, ['address']);
    },
  );
  await withApi(undefined, async (get) => {
    const res = await get(query);
    assert.equal(res.status, 503);
  });
});

test('GET /geocode: 예상 못 한 오류도 503으로 답하고 주소를 밖으로 내보내지 않는다 (SER-012)', async () => {
  await withApi(
    async () => {
      throw new Error(`예상 못 한 오류 ${ADDRESS}`);
    },
    async (get, logs) => {
      const res = await get(query);
      assert.equal(res.status, 503);
      assert.ok(!res.text.includes('신부동'));
      assert.ok(!logs.join('\n').includes('신부동'));
      assert.ok(!logs.join('\n').includes(encodeURIComponent('신부동')));
    },
  );
});
