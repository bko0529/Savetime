// 예상 이동시간: 카카오모빌리티 자동차 길찾기 (SFR-072·073, INR-002)
// 정렬은 이미 직선거리로 끝나 있다. 여기서는 카드에 '몇 분'을 채우기만 하고, 실패하면 null로 둔다.
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ApiQuota } from '../collector/quota.js';

const DIRECTIONS_URL = 'https://apis-navi.kakaomobility.com/v1/directions';
// 추천 응답 3초 안(PER-001)에 끝내려고 한 곳당 2초까지만 기다린다. 10곳을 동시에 부른다.
const REQUEST_TIMEOUT_MS = 2_000;
// 같은 자리에서 새로고침하면 다시 부르지 않는다. 병상 수집 주기(3분)와 맞춘다.
const CACHE_SECONDS = 180;

export interface Point {
  lat: number;
  lng: number;
}

export type EtaLookup = (
  origin: Point,
  destinations: (Point & { id: string })[],
) => Promise<Map<string, number>>;

// 출발지를 소수 셋째 자리(약 100m)로 묶어 캐시 키로 쓴다. 구급차가 조금 움직였다고 다시 부르지 않는다.
function cacheKey(origin: Point, hospitalId: string): string {
  return `eta:${origin.lat.toFixed(3)}:${origin.lng.toFixed(3)}:${hospitalId}`;
}

function toMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

export interface EtaOptions {
  apiKey: string;
  redis: Redis;
  quota: Pick<ApiQuota, 'take' | 'isExhausted' | 'save'>;
  logger: Logger;
  fetchFn?: typeof fetch;
}

export function createEtaLookup({
  apiKey,
  redis,
  quota,
  logger,
  fetchFn = fetch,
}: EtaOptions): EtaLookup {
  // 한 곳만 부른다. 어떤 이유로 실패해도 예외를 던지지 않고 undefined를 돌려준다 (SFR-073).
  async function fetchMinutes(origin: Point, destination: Point): Promise<number | undefined> {
    const url = new URL(DIRECTIONS_URL);
    url.search = new URLSearchParams({
      // 카카오는 '경도,위도' 순서다
      origin: `${origin.lng},${origin.lat}`,
      destination: `${destination.lng},${destination.lat}`,
      summary: 'true',
    }).toString();
    try {
      await quota.take();
      const res = await fetchFn(url, {
        headers: { Authorization: `KakaoAK ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        routes?: { result_code?: number; summary?: { duration?: number } }[];
      };
      const route = body.routes?.[0];
      // result_code 0 = 길찾기 성공. 그 밖(경로 없음 등)은 이동시간 없음으로 둔다
      if (route?.result_code !== 0 || typeof route.summary?.duration !== 'number') return undefined;
      return toMinutes(route.summary.duration);
    } catch {
      return undefined;
    }
  }

  return async (origin, destinations) => {
    const result = new Map<string, number>();
    if (destinations.length === 0) return result;

    const keys = destinations.map((d) => cacheKey(origin, d.id));
    const cached = await redis.mget(keys).catch(() => keys.map(() => null));
    const missing = destinations.filter((d, i) => {
      if (cached[i] === null) return true;
      result.set(d.id, Number(cached[i]));
      return false;
    });
    if (missing.length === 0) return result;

    // 오늘 무료량을 다 썼으면 부르지 않는다. Redis가 비었을 때 DB 기록으로 이어서 센다 (SFR-090과 같은 방식)
    if (await quota.isExhausted().catch(() => true)) return result;

    const minutes = await Promise.all(missing.map((d) => fetchMinutes(origin, d)));
    const failed = minutes.filter((m) => m === undefined).length;
    if (failed > 0)
      logger.warn({ failed, total: missing.length }, '예상 이동시간 일부를 구하지 못했어요');

    const pipeline = redis.pipeline();
    missing.forEach((d, i) => {
      const value = minutes[i];
      if (value === undefined) return; // 실패는 저장하지 않아 다음 새로고침 때 다시 부른다
      result.set(d.id, value);
      pipeline.set(cacheKey(origin, d.id), value, 'EX', CACHE_SECONDS);
    });
    await pipeline.exec().catch(() => {});
    await quota.save().catch(() => {});
    return result;
  };
}
