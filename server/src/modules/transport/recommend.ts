// 주변 병원(지도·미리 불러오기)과 추천 목록 (SFR-001·027·002·098·087)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { isInKorea, RADIUS_KM } from '../../domain/geo.js';
import { AppError } from '../../http/errors.js';
import { paramedicAuth } from '../auth/guards.js';
import type { EtaLookup } from './eta.js';
import { rankHospitals, type BedPair, type Candidate, type Ranked } from './rank.js';

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
  collected_at: Date | null;
  stale: boolean | null;
  capability_available: number;
  capability_total: number;
}

// 화면의 '기준 HH:MM'은 서버가 수집한 시각(collected_at)이고, 그때부터 10분이 지나면 '참고용 정보'다 (SFR-081, C-12).
// 수집이 실패하면 collected_at 이 그대로라 10분 뒤 자연히 참고용이 된다 (SFR-008).
// 판정은 DB now() 로 한다 (규칙 6). 폰 시계가 틀려도 온라인 화면은 맞다. 병상 데이터가 없으면 null
export const FRESH_MINUTES = 10;
export const STALE_SQL = `(c.collected_at < now() - make_interval(mins => ${FRESH_MINUTES}))`;

// 반경 안 병원. 먼저 위도·경도 네모로 빠르게 거르고(1도 ≈ 111km), 하버사인 직선거리로 정확히 자른다.
// 전국 응급실이 수백 곳이라 PostGIS 없이 충분하다 (기술정의서 추천 정렬).
const CANDIDATES_SQL = `
  SELECT h.id, h.name, h.lat::float8 AS lat, h.lng::float8 AS lng, h.address, h.er_phone, h.grade,
         d.km AS distance_km,
         c.hospital_id IS NOT NULL AS has_bed_row, coalesce(c.excluded, false) AS anomaly,
         c.er_avail, c.er_total, c.icu_avail, c.icu_total, c.or_avail, c.or_total, c.source_time,
         c.collected_at, ${STALE_SQL} AS stale,
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

// 풀이든 트랜잭션 안의 client든 받는다 (전화 거절의 다음 후보는 같은 트랜잭션에서 계산, SFR-074)
type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

async function findCandidates(
  pool: Queryable,
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

function toCard(candidate: Row, rank: number | null, etas?: Map<string, number>) {
  const { row, beds } = candidate;
  return {
    id: Number(row.id),
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    distanceKm: Math.round(row.distance_km * 10) / 10,
    // 길찾기에 실패했거나 대상(가까운 10곳)이 아니면 null → 앱은 '예상 이동시간 없음' (SFR-073)
    etaMin: etas?.get(candidate.id) ?? null,
    beds: { er: bedText(beds?.er), icu: bedText(beds?.icu), or: bedText(beds?.or) },
    bedsSourceTime: row.source_time,
    collectedAt: row.collected_at,
    stale: row.stale,
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

export interface TransportRanking {
  radiusKm: number;
  origin: { lat: number; lng: number };
  candidates: Row[];
  ranked: Ranked<Row>;
}

// 이송 건 하나의 추천 산출 (SFR-098). 추천 API와 전화 거절 뒤 다음 후보(SFR-074)가 같이 써서
// 앱에 보이는 순서와 서버가 고르는 다음 병원이 늘 같다 (SFR-112). 내 팀 이송 건이 아니면 null (SER-010)
export async function rankForTransport(
  db: Queryable,
  transportId: string,
  paramedicId: string,
): Promise<TransportRanking | null> {
  const { rows } = await db.query<{
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
    [transportId, paramedicId],
  );
  const transport = rows[0];
  if (!transport) return null;
  if (transport.origin_lat === null || transport.origin_lng === null) {
    // 주소만 있는 이송 건은 주소→좌표 변환(SFR-009)이 생기면 좌표가 채워진다
    throw new AppError(409, 'LOCATION_REQUIRED', '출발 위치를 알 수 없어요');
  }

  const { rows: excluded } = await db.query<{ hospital_id: string }>(
    'SELECT hospital_id FROM excluded_hospital WHERE transport_id = $1',
    [transportId],
  );
  const radiusKm = transport.fallback_radius_km;
  const origin = { lat: transport.origin_lat, lng: transport.origin_lng };
  const candidates = await findCandidates(
    db,
    origin,
    radiusKm,
    new Set(excluded.map((row) => row.hospital_id)),
  );
  const ranked = rankHospitals(candidates, {
    requestedGrade: transport.requested_grade,
    radiusKm,
  });
  return { radiusKm, origin, candidates, ranked };
}

// eta가 없으면(카카오 키 없음) 예상 이동시간만 빠지고 추천은 그대로 나간다
export function recommendRouter(pool: pg.Pool, guards: RequestHandler[], eta?: EtaLookup): Router {
  const router = Router();

  // 환자 정보를 입력하는 동안 앱이 미리 받아 두는 반경 안 전체 병원 (SFR-001, 지도 SFR-027)
  router.get('/hospitals/nearby', ...guards, async (req, res) => {
    const { lat, lng, radiusKm } = parseOrigin(req.query);
    const candidates = await findCandidates(pool, { lat, lng }, radiusKm);
    // 앱이 오프라인 대비로 저장하는 목록이라 진료가능 항목도 넣는다 (SFR-059). 추천 목록에는 개수만
    const { rows: caps } = await pool.query<{
      hospital_id: string;
      capabilities: { name: string; available: boolean }[];
    }>(
      `SELECT hc.hospital_id,
              jsonb_agg(jsonb_build_object('name', i.name, 'available', hc.available)
                        ORDER BY length(i.code), i.code) AS capabilities
         FROM hospital_capability hc
         JOIN capability_item i ON i.code = hc.item_code
        WHERE hc.hospital_id = ANY($1::bigint[])
        GROUP BY hc.hospital_id`,
      [candidates.map((c) => c.id)],
    );
    const capsOf = new Map(caps.map((row) => [row.hospital_id, row.capabilities]));
    res.json(
      candidates.map((candidate) => ({
        ...toCard(candidate, null),
        capabilities: capsOf.get(candidate.id) ?? [],
      })),
    );
  });

  router.get('/transports/:transportId/recommendations', ...guards, async (req, res) => {
    const transportId = String(req.params.transportId);
    const notFound = new AppError(404, 'NOT_FOUND', '이송 건을 찾을 수 없어요');
    if (!UUID.test(transportId)) throw notFound;

    const result = await rankForTransport(pool, transportId, paramedicAuth(res).paramedicId);
    if (!result) throw notFound;
    const { radiusKm, origin, candidates, ranked } = result;
    const rankOf = new Map(ranked.items.map((item) => [item.id, item.rank]));
    const etas = eta
      ? await eta(
          origin,
          ranked.etaTargets.map((c) => ({ id: c.id, lat: c.row.lat, lng: c.row.lng })),
        )
      : undefined;

    res.json({
      radiusKm,
      items: ranked.items.map((item) => toCard(item, item.rank, etas)),
      map: candidates.map((candidate) => toCard(candidate, rankOf.get(candidate.id) ?? null, etas)),
      noBedInfo: ranked.noBedInfo.map((candidate) => toCard(candidate, null)),
      emptyGuide: ranked.emptyGuide,
    });
  });

  return router;
}
