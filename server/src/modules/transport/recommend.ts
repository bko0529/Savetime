// 주변 병원(지도·미리 불러오기)과 추천 목록 (SFR-001·027·002·098·087)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { isInKorea, RADIUS_KM } from '../../domain/geo.js';
import { AppError } from '../../http/errors.js';
import { paramedicAuth } from '../auth/guards.js';
import { rankHospitals, type BedPair, type Candidate } from './rank.js';

interface CandidateRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  er_phone: string | null;
  grade: number;
  distance_km: number;
  has_bed_row: boolean;
  anomaly: boolean;
  er_avail: number | null;
  er_total: number | null;
  icu_avail: number | null;
  icu_total: number | null;
  or_avail: number | null;
  or_total: number | null;
  source_time: Date | null;
  capability_available: number;
  capability_total: number;
}

// 반경 안 병원. 먼저 위도·경도 네모로 빠르게 거르고(1도 ≈ 111km), 하버사인 직선거리로 정확히 자른다.
// 전국 응급실이 수백 곳이라 PostGIS 없이 충분하다 (기술정의서 추천 정렬).
const CANDIDATES_SQL = `
  SELECT h.id, h.name, h.lat::float8 AS lat, h.lng::float8 AS lng, h.address, h.er_phone, h.grade,
         d.km AS distance_km,
         c.hospital_id IS NOT NULL AS has_bed_row, coalesce(c.excluded, false) AS anomaly,
         c.er_avail, c.er_total, c.icu_avail, c.icu_total, c.or_avail, c.or_total, c.source_time,
         cap.available AS capability_available, cap.total AS capability_total
    FROM hospital h
    LEFT JOIN bed_current c ON c.hospital_id = h.id
    CROSS JOIN LATERAL (
      SELECT 2 * 6371 * asin(sqrt(
               power(sin(radians(h.lat::float8 - $1) / 2), 2)
               + cos(radians($1)) * cos(radians(h.lat::float8))
                 * power(sin(radians(h.lng::float8 - $2) / 2), 2))) AS km
    ) d
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE available)::int AS available, count(*)::int AS total
        FROM hospital_capability WHERE hospital_id = h.id
    ) cap
   WHERE h.lat BETWEEN $1 - $3 / 111.0 AND $1 + $3 / 111.0
     AND h.lng BETWEEN $2 - $3 / (111.0 * cos(radians($1))) AND $2 + $3 / (111.0 * cos(radians($1)))
     AND d.km <= $3
   ORDER BY d.km, h.id`;

type Row = Candidate & { row: CandidateRow };

async function findCandidates(
  pool: pg.Pool,
  origin: { lat: number; lng: number },
  radiusKm: number,
  excludedIds: Set<string> = new Set(),
): Promise<Row[]> {
  const { rows } = await pool.query<CandidateRow>(CANDIDATES_SQL, [
    origin.lat,
    origin.lng,
    radiusKm,
  ]);
  return rows.map((row) => ({
    id: row.id,
    distanceKm: row.distance_km,
    grade: row.grade,
    beds: row.has_bed_row
      ? {
          er: { avail: row.er_avail, total: row.er_total },
          icu: { avail: row.icu_avail, total: row.icu_total },
          or: { avail: row.or_avail, total: row.or_total },
        }
      : null,
    anomaly: row.anomaly,
    excluded: excludedIds.has(row.id),
    row,
  }));
}

// 카드의 병상은 '가용/전체'(예: 2/8). 가용이 비면 null로 보내 앱이 '정보 없음'으로 표시한다 (SFR-089)
function bedText(pair: BedPair | undefined): string | null {
  if (!pair || pair.avail === null) return null;
  return pair.total === null ? String(pair.avail) : `${pair.avail}/${pair.total}`;
}

function toCard(candidate: Row, rank: number | null) {
  const { row, beds } = candidate;
  return {
    id: Number(row.id),
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    distanceKm: Math.round(row.distance_km * 10) / 10,
    etaMin: null, // 길찾기 예상 이동시간은 SFR-072에서 채운다
    beds: { er: bedText(beds?.er), icu: bedText(beds?.icu), or: bedText(beds?.or) },
    bedsSourceTime: row.source_time,
    capabilityCount: { available: row.capability_available, total: row.capability_total },
    inRegion: beds !== null && [beds.er, beds.icu, beds.or].some((p) => p.avail !== null),
    erPhone: row.er_phone,
    rank,
    excluded: candidate.excluded,
    grade: row.grade,
  };
}

const nearbySchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radiusKm: z.coerce
    .number()
    .refine((v) => (RADIUS_KM as readonly number[]).includes(v))
    .default(20),
});

// 잘못된 좌표로 조회하지 않는다. 대한민국 밖이면 사유를 돌려준다 (SFR-087)
function parseOrigin(query: unknown): { lat: number; lng: number; radiusKm: number } {
  const parsed = nearbySchema.safeParse(query);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new AppError(400, 'VALIDATION_FAILED', '입력 형식이 맞지 않아요', { fields });
  }
  if (!isInKorea(parsed.data.lat, parsed.data.lng)) {
    throw new AppError(400, 'VALIDATION_FAILED', '좌표 범위 오류: 대한민국 밖 좌표예요', {
      fields: ['lat', 'lng'],
      reason: 'coords_out_of_korea',
    });
  }
  return parsed.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function recommendRouter(pool: pg.Pool, guards: RequestHandler[]): Router {
  const router = Router();

  // 환자 정보를 입력하는 동안 앱이 미리 받아 두는 반경 안 전체 병원 (SFR-001, 지도 SFR-027)
  router.get('/hospitals/nearby', ...guards, async (req, res) => {
    const { lat, lng, radiusKm } = parseOrigin(req.query);
    const candidates = await findCandidates(pool, { lat, lng }, radiusKm);
    res.json(candidates.map((candidate) => toCard(candidate, null)));
  });

  router.get('/transports/:transportId/recommendations', ...guards, async (req, res) => {
    const transportId = String(req.params.transportId);
    const notFound = new AppError(404, 'NOT_FOUND', '이송 건을 찾을 수 없어요');
    if (!UUID.test(transportId)) throw notFound;

    // 내 팀의 이송 건만 본다. 남의 것은 있는지조차 알리지 않는다 (SER-010)
    const { rows } = await pool.query<{
      origin_lat: number | null;
      origin_lng: number | null;
      fallback_radius_km: number;
      requested_grade: number | null;
    }>(
      `SELECT t.origin_lat::float8 AS origin_lat, t.origin_lng::float8 AS origin_lng,
              t.fallback_radius_km, t.requested_grade
         FROM transport t
         JOIN team_member tm ON tm.team_id = t.team_id AND tm.left_at IS NULL
        WHERE t.id = $1 AND tm.paramedic_id = $2`,
      [transportId, paramedicAuth(res).paramedicId],
    );
    const transport = rows[0];
    if (!transport) throw notFound;
    if (transport.origin_lat === null || transport.origin_lng === null) {
      // 주소만 있는 이송 건은 주소→좌표 변환(SFR-009)이 생기면 좌표가 채워진다
      throw new AppError(409, 'LOCATION_REQUIRED', '출발 위치를 알 수 없어요');
    }

    const { rows: excluded } = await pool.query<{ hospital_id: string }>(
      'SELECT hospital_id FROM excluded_hospital WHERE transport_id = $1',
      [transportId],
    );
    const radiusKm = transport.fallback_radius_km;
    const candidates = await findCandidates(
      pool,
      { lat: transport.origin_lat, lng: transport.origin_lng },
      radiusKm,
      new Set(excluded.map((row) => row.hospital_id)),
    );
    const ranked = rankHospitals(candidates, {
      requestedGrade: transport.requested_grade,
      radiusKm,
    });
    const rankOf = new Map(ranked.items.map((item) => [item.id, item.rank]));

    res.json({
      radiusKm,
      items: ranked.items.map((item) => toCard(item, item.rank)),
      map: candidates.map((candidate) => toCard(candidate, rankOf.get(candidate.id) ?? null)),
      noBedInfo: ranked.noBedInfo.map((candidate) => toCard(candidate, null)),
      emptyGuide: ranked.emptyGuide,
    });
  });

  return router;
}
