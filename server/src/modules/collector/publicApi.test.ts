import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBeds } from './parseBeds.js';
import { CollectError, createFetchBeds } from './publicApi.js';

const signal = new AbortController().signal;
const KEY = 'test-key-1234';

// 실제 응답과 같은 모양 (2026-11-02 충청남도 응답에서 필요한 필드만 남김)
const bedItem = {
  hpid: 'A2400003',
  dutyName: '서산중앙병원',
  hvec: 14,
  hvs01: 17,
  hvicc: 6,
  hvs17: 8,
  hvoc: 4,
  hvs22: 4,
  hv6: -1,
  hvidate: 20261102103000,
};

function okResponse(items: unknown): Response {
  return Response.json({
    response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items } },
  });
}

test('부록 D대로 3종 병상으로 바꾸고 기준 시각은 한국 시간으로 읽는다', () => {
  const [row] = parseBeds([bedItem]);
  assert.equal(row.publicId, 'A2400003');
  assert.deepEqual(
    [row.erAvail, row.erTotal, row.icuAvail, row.icuTotal, row.orAvail, row.orTotal],
    [14, 17, 6, 8, 4, 4],
  );
  assert.equal(new Date(row.sourceTime).toISOString(), '2026-11-02T01:30:00.000Z');
});

test('중환자실 필드가 없는 병원은 그 항목만 비운다', () => {
  const [row] = parseBeds([{ ...bedItem, hvicc: undefined, hvs17: undefined }]);
  assert.equal(row.icuAvail, undefined);
  assert.equal(row.erAvail, 14);
});

test('형식이 깨진 병원은 빼고 나머지는 살린다', () => {
  const rows = parseBeds([{ ...bedItem, hvidate: '어제' }, { hvec: 1 }, bedItem]);
  assert.equal(rows.length, 1);
});

test('주소에 키·시·도·JSON 요청을 담고, 1건·0건 응답도 처리한다', async () => {
  let called: URL | undefined;
  const fetchOne = createFetchBeds(KEY, (async (url: URL) => {
    called = url;
    return okResponse({ item: bedItem });
  }) as typeof fetch);
  assert.equal((await fetchOne('세종특별자치시', signal)).length, 1);
  assert.equal(called?.searchParams.get('serviceKey'), KEY);
  assert.equal(called?.searchParams.get('STAGE1'), '세종특별자치시');
  assert.equal(called?.searchParams.get('_type'), 'json');

  const fetchNone = createFetchBeds(KEY, (async () => okResponse('')) as typeof fetch);
  assert.deepEqual(await fetchNone('세종특별자치시', signal), []);
});

test('실패하면 1회 다시 조회하고, 성공하면 그 값을 쓴다 (SFR-024)', async () => {
  let calls = 0;
  const fetchBeds = createFetchBeds(KEY, (async () => {
    calls += 1;
    if (calls === 1) return new Response('', { status: 500 });
    return okResponse({ item: [bedItem] });
  }) as typeof fetch);
  assert.equal((await fetchBeds('충청남도', signal)).length, 1);
  assert.equal(calls, 2);
});

test('재조회까지 실패하면 코드만 담긴 오류를 낸다. 키는 들어가지 않는다', async () => {
  let calls = 0;
  const fetchBeds = createFetchBeds(KEY, (async (url: URL) => {
    calls += 1;
    throw new Error(`연결 실패 ${url.toString()}`);
  }) as typeof fetch);
  await assert.rejects(fetchBeds('충청남도', signal), (err: Error) => {
    assert.ok(err instanceof CollectError);
    assert.equal(err.code, 'NETWORK');
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  assert.equal(calls, 2);
});

test('공공 API 오류 코드는 RESULT_코드로 남긴다', async () => {
  const fetchBeds = createFetchBeds(KEY, (async () =>
    Response.json({
      response: { header: { resultCode: '22', resultMsg: 'LIMITED NUMBER OF SERVICE REQUESTS' } },
    })) as typeof fetch);
  await assert.rejects(fetchBeds('충청남도', signal), { code: 'RESULT_22' });
});

test('마감이 지났으면 다시 조회하지 않는다', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchBeds = createFetchBeds(KEY, (async () => {
    calls += 1;
    controller.abort();
    throw new Error('aborted');
  }) as typeof fetch);
  await assert.rejects(fetchBeds('충청남도', controller.signal), { code: 'DEADLINE' });
  assert.equal(calls, 1);
});
