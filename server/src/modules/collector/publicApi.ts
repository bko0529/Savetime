// 국립중앙의료원 응급의료정보 API 호출 (INR-001). 키는 주소에 들어가므로 오류에 주소를 담지 않는다 (SER-001).
import { z } from 'zod';
import { parseBeds, type BedRow } from './parseBeds.js';

const BASE_URL = 'https://apis.data.go.kr/B552657/ErmctInfoInqireService';
const BEDS_OPERATION = 'getEmrrmRltmUsefulSckbdInfoInqire';
const REQUEST_TIMEOUT_MS = 10_000;
const NUM_OF_ROWS = '1000'; // 시·도 하나를 한 번의 호출로 받는다

export type FetchItems = (
  operation: string,
  params: Record<string, string>,
  signal: AbortSignal,
) => Promise<unknown[]>;

export type FetchBeds = (region: string, signal: AbortSignal) => Promise<BedRow[]>;

// collect_log에 남길 코드만 담는다. 원래 오류 문구에는 키가 든 주소가 있을 수 있다.
export class CollectError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

// 결과가 0건이면 items가 빈 문자열, 1건이면 배열이 아니라 객체로 온다.
const responseSchema = z.object({
  response: z.object({
    header: z.object({ resultCode: z.string() }),
    body: z
      .object({
        items: z.union([
          z.literal(''),
          z.object({ item: z.union([z.array(z.unknown()), z.unknown()]) }),
        ]),
      })
      .optional(),
  }),
});

function toItems(body: z.infer<typeof responseSchema>['response']['body']): unknown[] {
  if (!body || body.items === '') return [];
  const { item } = body.items;
  return Array.isArray(item) ? item : [item];
}

async function fetchOnce(url: URL, signal: AbortSignal, fetchFn: typeof fetch): Promise<unknown[]> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch {
    throw new CollectError(signal.aborted ? 'DEADLINE' : 'NETWORK');
  }
  if (!res.ok) throw new CollectError(`HTTP_${res.status}`);

  let parsed;
  try {
    parsed = responseSchema.parse(await res.json());
  } catch {
    throw new CollectError(signal.aborted ? 'DEADLINE' : 'BAD_RESPONSE');
  }
  const { resultCode } = parsed.response.header;
  if (resultCode !== '00') throw new CollectError(`RESULT_${resultCode}`);
  return toItems(parsed.response.body);
}

// beforeCall은 실제 호출마다 돈다. 재조회도 호출 수에 들어간다 (SFR-090).
// beforeCall은 실제 호출마다 돈다. 재조회도 호출 수에 들어간다 (SFR-090).
export function createFetchItems(
  serviceKey: string,
  beforeCall: () => Promise<void>,
  fetchFn: typeof fetch = fetch,
): FetchItems {
  return async (operation, params, signal) => {
    const url = new URL(`${BASE_URL}/${operation}`);
    url.search = new URLSearchParams({
      serviceKey,
      pageNo: '1',
      numOfRows: NUM_OF_ROWS,
      _type: 'json',
      ...params,
    }).toString();

    await beforeCall();
    try {
      return await fetchOnce(url, signal, fetchFn);
    } catch (err) {
      // 마감이 지났으면 다시 해도 소용없다. 그 밖의 실패는 1회 다시 조회한다 (SFR-024).
      if (signal.aborted) throw err;
      await beforeCall();
      return fetchOnce(url, signal, fetchFn);
    }
  };
}

export function createFetchBeds(
  serviceKey: string,
  beforeCall: () => Promise<void>,
  fetchFn: typeof fetch = fetch,
): FetchBeds {
  const fetchItems = createFetchItems(serviceKey, beforeCall, fetchFn);
  return async (region, signal) =>
    parseBeds(await fetchItems(BEDS_OPERATION, { STAGE1: region }, signal));
}
