// 대원 앱에 보내는 이송 건 모양 (openapi Transport). 만들기·진행 중 불러오기·이후 상태 변경 응답이 같이 쓴다.
// 환자 평가 내용은 넣지 않는다. 병원 요청도 병원 이름·상태·시간만 (AppHospitalRequest).
import type pg from 'pg';
import type { HreqStatus } from '../../domain/stateMachine.js';

type Db = pg.Pool | pg.PoolClient;

interface TransportRow {
  id: string;
  status: string;
  version: number;
  server_now: Date;
  request_radius_km: number;
  fallback_radius_km: number;
  fallback_reason: string | null;
  requested_grade: number | null;
  location_consent: boolean;
  address: string | null;
  offline_created: boolean;
  nav_device_id: string | null;
  departed_at: Date | null;
  dest_changed_at: Date | null;
  distance_m: number | null;
  created_at: Date;
  phone_target_hospital_id: string | null;
  phone_target_name: string | null;
  phone_target_er_phone: string | null;
  last_seq: number | null;
}

interface RoundRow {
  id: string;
  round_no: number;
  kind: string;
  radius_km: number;
  sent_at: Date;
  respond_until: Date;
  approval_valid_until: Date;
  delivery_final: boolean;
}

interface RequestRow {
  id: string;
  hospital_id: string;
  name: string;
  lat: number;
  lng: number;
  entrance_lat: number | null;
  entrance_lng: number | null;
  status: HreqStatus;
  closed_reason: string | null;
  eta_min: number | null;
  eta_source: string | null;
  er_avail: number | null;
  er_total: number | null;
  memo: string | null;
  extra_memo: string | null;
  reason: string | null;
  reason_text: string | null;
  responded_at: Date | null;
  delivered_at: Date | null;
  prev_approved_recheck: boolean;
  version: number;
  round_id: string;
}

// 내 팀의 이송 건만 돌려준다. 남의 것이면 undefined (있는지조차 알리지 않음, SER-010)
export async function loadTransport(db: Db, transportId: string, paramedicId: string) {
  const { rows } = await db.query<TransportRow>(
    `SELECT t.id, t.status, t.version, now() AS server_now, t.request_radius_km, t.fallback_radius_km,
            t.fallback_reason, t.requested_grade, t.location_consent, t.address, t.offline_created,
            t.nav_device_id, t.departed_at, t.dest_changed_at, t.distance_m, t.created_at,
            t.phone_target_hospital_id, ph.name AS phone_target_name, ph.er_phone AS phone_target_er_phone,
            (SELECT max(seq) FROM assessment a WHERE a.transport_id = t.id) AS last_seq
       FROM transport t
       JOIN team_member tm ON tm.team_id = t.team_id AND tm.left_at IS NULL AND tm.paramedic_id = $2
       LEFT JOIN hospital ph ON ph.id = t.phone_target_hospital_id
      WHERE t.id = $1`,
    [transportId, paramedicId],
  );
  const t = rows[0];
  if (!t) return undefined;

  const { rows: rounds } = await db.query<RoundRow>(
    `SELECT id, round_no, kind, radius_km, sent_at, respond_until, approval_valid_until,
            -- 5초 판정이 끝남 = 받았음도 전달 실패도 아닌 대기 요청이 남아 있지 않음 (SFR-161)
            NOT EXISTS (
              SELECT 1 FROM hospital_request hr
               WHERE hr.round_id = request_round.id AND hr.status = 'waiting' AND hr.delivered_at IS NULL
            ) AS delivery_final
       FROM request_round WHERE transport_id = $1 ORDER BY round_no DESC LIMIT 1`,
    [transportId],
  );
  const round = rounds[0];

  // 현재 회차 요청 + (앞 회차에서) 확정된 요청. 승인은 승인 시각 순 (SFR-110)
  const { rows: requests } = await db.query<RequestRow>(
    `SELECT hr.id, hr.hospital_id, h.name, h.lat::float8 AS lat, h.lng::float8 AS lng,
            h.entrance_lat::float8 AS entrance_lat, h.entrance_lng::float8 AS entrance_lng,
            hr.status, hr.closed_reason, hr.eta_min, hr.eta_source, b.er_avail, b.er_total,
            hr.memo, hr.extra_memo, hr.reason, hr.reason_text, hr.responded_at, hr.delivered_at,
            hr.prev_approved_recheck, hr.version, hr.round_id
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       JOIN hospital h ON h.id = hr.hospital_id
       LEFT JOIN bed_current b ON b.hospital_id = h.id
      WHERE r.transport_id = $1 AND (hr.round_id = $2 OR hr.status IN ('confirmed', 'arrived'))
      ORDER BY hr.responded_at NULLS LAST, hr.eta_min NULLS LAST, hr.id`,
    [transportId, round?.id ?? null],
  );

  const { rows: excluded } = await db.query<{ hospital_id: string }>(
    'SELECT hospital_id FROM excluded_hospital WHERE transport_id = $1 ORDER BY hospital_id',
    [transportId],
  );

  const approvedLike = requests.filter((r) => r.status === 'approved' || r.status === 'confirmed');
  const closestEta = Math.min(...approvedLike.map((r) => r.eta_min ?? Infinity));
  const confirmed = requests.find(
    (r) =>
      r.status === 'confirmed' ||
      r.status === 'arrived' ||
      (r.status === 'closed' && r.closed_reason === 'approval_cancelled' && t.status === 'moving'),
  );
  const currentRequests = round ? requests.filter((r) => r.round_id === round.id) : [];

  return {
    id: t.id,
    status: t.status,
    version: t.version,
    serverNow: t.server_now,
    requestRadiusKm: t.request_radius_km,
    fallbackRadiusKm: t.fallback_radius_km,
    fallbackReason: t.fallback_reason,
    currentRound: round
      ? {
          roundNo: round.round_no,
          kind: round.kind,
          radiusKm: round.radius_km,
          sentAt: round.sent_at,
          respondUntil: round.respond_until,
          approvalValidUntil: round.approval_valid_until,
          targetCount: currentRequests.length,
          deliveredCount: currentRequests.filter((r) => r.delivered_at !== null).length,
          deliveryFinal: round.delivery_final,
        }
      : null,
    requests: requests.map((r) => ({
      id: Number(r.id),
      hospitalId: Number(r.hospital_id),
      hospitalName: r.name,
      lat: r.lat,
      lng: r.lng,
      status: r.status,
      closeReason: r.closed_reason,
      etaMin: r.eta_min,
      etaSource: r.eta_source,
      erBeds: r.er_avail === null ? null : `${r.er_avail}/${r.er_total ?? '?'}`,
      memo: r.memo,
      extraMemo: r.extra_memo,
      reason: r.reason,
      reasonText: r.reason_text,
      approvedAt: r.status === 'approved' || r.status === 'confirmed' ? r.responded_at : null,
      isClosest:
        (r.status === 'approved' || r.status === 'confirmed') &&
        r.eta_min !== null &&
        r.eta_min === closestEta,
      prevApprovedRecheck: r.prev_approved_recheck,
      version: r.version,
    })),
    phoneTarget: t.phone_target_hospital_id
      ? {
          hospitalId: Number(t.phone_target_hospital_id),
          name: t.phone_target_name,
          erPhone: t.phone_target_er_phone,
        }
      : null,
    confirmedHospital: confirmed
      ? {
          id: Number(confirmed.hospital_id),
          name: confirmed.name,
          memo: confirmed.memo,
          extraMemo: confirmed.extra_memo,
          entrance: {
            lat: confirmed.entrance_lat ?? confirmed.lat,
            lng: confirmed.entrance_lng ?? confirmed.lng,
          },
          requestStatus: confirmed.status,
          closeReason: confirmed.closed_reason,
        }
      : null,
    canReRequest:
      t.status === 'moving' &&
      confirmed?.status === 'closed' &&
      confirmed.closed_reason === 'approval_cancelled',
    destinationChangeUsed: t.dest_changed_at !== null,
    navDeviceId: t.nav_device_id,
    // 이동 중 남은 시간은 위치 기록(S5)이 생기면 1분마다 다시 계산한다
    etaMin: null,
    departedAt: t.departed_at,
    lastSentAssessmentSeq: t.last_seq ?? 0,
    // 팀 작성 중 환자 정보(S6)와 비교해 센다. 지금은 0
    pendingChanges: 0,
    excludedHospitalIds: excluded.map((e) => Number(e.hospital_id)),
    locationConsent: t.location_consent,
    address: t.address,
    offlineCreated: t.offline_created,
    createdAt: t.created_at,
    requestedGrade: t.requested_grade,
    distanceKm: t.distance_m === null ? null : Math.round(t.distance_m / 100) / 10,
  };
}
