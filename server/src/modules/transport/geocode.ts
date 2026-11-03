// 주소 → 좌표: 카카오 로컬 API를 서버가 대신 부른다 (SFR-009, INR-004). 키를 앱에 넣지 않는다 (SER-001).
// 현장 주소는 환자 집 주소일 수 있다. 입력한 주소와 결과를 로그·DB·Redis 어디에도 남기지 않는다 (SER-012).
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { isInKorea } from '../../domain/geo.js';
import { AppError } from '../../http/errors.js';
import type { ApiQuota } from '../collector/quota.js';

const ADDRESS_URL = 'https://dapi.kakao.com/v2/local/search/address.json';
const KEYWORD_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const TIMEOUT_MS = 3_000; // INR-004 요청 제한시간 (두 번 검색해도 합쳐서 3초)
const MAX_RESULTS = 5;

export interface GeocodeResult {
  address: string;
  location: { lat: number; lng: number };
}

export type Geocoder = (address: string) => Promise<GeocodeResult[]>;

// 카카오가 응답하지 않거나 한도를 넘으면 '주소 없음'과 구분해서 알린다
export class GeocodeUnavailable extends Error {}

// 카카오는 좌표를 문자열 x(경도)·y(위도)로 준다
const documentSchema = z.object({
  x: z.coerce.number(),
  y: z.coerce.number(),
  address_name: z.string().default(''),
  place_name: z.string().optional(),
  road_address_name: z.string().optional(),
});
const responseSchema = z.object({ documents: z.array(z.unknown()) });

function toResults(documents: unknown[]): GeocodeResult[] {
  const results: GeocodeResult[] = [];
  for (const raw of documents) {
    const parsed = documentSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { x, y, address_name, place_name, road_address_name } = parsed.data;
    if (!isInKorea(y, x)) continue;
    // 장소 검색 결과는 '천안역 (충남 천안시 동남구 ...)'처럼 이름과 주소를 같이 보여 준다
    const where = road_address_name || address_name;
    results.push({
      address: place_name ? `${place_name} (${where})` : where,
      location: { lat: y, lng: x },
    });
  }
  return results.slice(0, MAX_RESULTS);
}

export interface GeocoderOptions {
  apiKey: string;
  quota: Pick<ApiQuota, 'take' | 'save'>;
  fetchFn?: typeof fetch;
}

export function createGeocoder({ apiKey, quota, fetchFn = fetch }: GeocoderOptions): Geocoder {
  async function search(url: string, query: string, signal: AbortSignal): Promise<GeocodeResult[]> {
    const target = new URL(url);
    target.search = new URLSearchParams({ query, size: String(MAX_RESULTS) }).toString();
    try {
      await quota.take();
      const res = await fetchFn(target, {
        headers: { Authorization: `KakaoAK ${apiKey}` },
        signal,
      });
      if (!res.ok) throw new GeocodeUnavailable();
      const body = responseSchema.parse(await res.json());
      return toResults(body.documents);
    } catch {
      // 원래 오류에는 주소가 든 URL이 있을 수 있어 그대로 넘기지 않는다
      throw new GeocodeUnavailable();
    }
  }

  return async (address) => {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      // '천안시 동남구 신부동' 같은 주소를 먼저 찾고, 없으면 '천안역' 같은 장소 이름으로 한 번 더 찾는다
      const byAddress = await search(ADDRESS_URL, address, signal);
      if (byAddress.length > 0) return byAddress;
      return await search(KEYWORD_URL, address, signal);
    } finally {
      await quota.save().catch(() => {});
    }
  };
}

const querySchema = z.object({ address: z.string().trim().min(2).max(100) });

// 키가 없으면(geocoder 없음) 503으로 알린다. 서버는 켜진다.
export function geocodeRouter(guards: RequestHandler[], geocoder?: Geocoder): Router {
  const router = Router();

  router.get('/geocode', ...guards, async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_FAILED', '주소를 2~100자로 입력해 주세요', {
        fields: ['address'],
      });
    }
    const unavailable = new AppError(
      503,
      'GEOCODE_UNAVAILABLE',
      '지금은 주소를 찾을 수 없어요. 잠시 후 다시 시도해 주세요',
    );
    if (!geocoder) throw unavailable;

    let results: GeocodeResult[];
    try {
      results = await geocoder(parsed.data.address);
    } catch {
      // 어떤 오류든 원래 내용(주소가 섞일 수 있음)을 밖으로 넘기지 않고 '잠시 후 다시'로 답한다
      throw unavailable;
    }
    if (results.length === 0) {
      throw new AppError(404, 'ADDRESS_NOT_FOUND', '주소를 찾을 수 없습니다');
    }
    res.json(results);
  });

  return router;
}
