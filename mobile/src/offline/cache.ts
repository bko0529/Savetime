/**
 * 병원 목록 저장 (SFR-059 · 061): 조회에 성공할 때마다 이 휴대폰에 저장, 지역별 최근 10건.
 * 지역은 좌표를 약 5km 칸(0.05°)으로 묶어 정한다 (시·군·구 대신. 서버에 주소를 묻지 않으려고).
 * 저장 항목: 병원명·좌표·연락처·병상 3종·진료가능 항목(수)·예상 이동시간·기준 시각(collectedAt).
 * 오프라인이면 서버가 다시 계산하지 않은 마지막 결과를 '참고용 정보 · 기준 HH:MM'으로 보인다.
 */
import type { LatLng } from '../transport/location';
import { db } from './db';

export const KEEP_PER_REGION = 10;
export type CachedCard = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  etaMin: number | null;
  beds: { er: string | null; icu: string | null; or: string | null };
  bedsSourceTime: string | null;
  capabilityCount: { available: number; total: number };
  capabilities?: { name: string; available: boolean }[];
  erPhone: string | null;
  grade: number;
  collectedAt?: string | null;
  stale?: boolean | null;
};

export const regionOf = (at: LatLng) =>
  `${(Math.round(at.lat * 20) / 20).toFixed(2)},${(Math.round(at.lng * 20) / 20).toFixed(2)}`;

export async function saveCards(at: LatLng, cards: CachedCard[], now = Date.now()) {
  if (cards.length === 0) return;
  const d = await db();
  const region = regionOf(at);
  await d.runAsync(
    'INSERT INTO hospital_cache (region, saved_at, data) VALUES (?, ?, ?)',
    region,
    now,
    JSON.stringify({ at, cards }),
  );
  // 지역마다 최근 10건만 남긴다
  await d.runAsync(
    'DELETE FROM hospital_cache WHERE region = ? AND id NOT IN (SELECT id FROM hospital_cache WHERE region = ? ORDER BY saved_at DESC, id DESC LIMIT ?)',
    region,
    region,
    KEEP_PER_REGION,
  );
}

/** 이 위치에서 가장 최근 저장한 목록 (같은 지역 먼저, 없으면 아무 지역의 가장 최근) */
export async function latestCards(
  at: LatLng | null,
): Promise<{ savedAt: number; cards: CachedCard[] } | null> {
  const d = await db();
  type Row = { saved_at: number; data: string };
  const row =
    (at
      ? await d.getFirstAsync<Row>(
          'SELECT saved_at, data FROM hospital_cache WHERE region = ? ORDER BY saved_at DESC, id DESC LIMIT 1',
          regionOf(at),
        )
      : null) ??
    (await d.getFirstAsync<Row>(
      'SELECT saved_at, data FROM hospital_cache ORDER BY saved_at DESC, id DESC LIMIT 1',
    ));
  if (!row) return null;
  return { savedAt: row.saved_at, cards: (JSON.parse(row.data) as { cards: CachedCard[] }).cards };
}
