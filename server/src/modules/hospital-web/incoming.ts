// 병원 웹 도착 예정 환자 목록 (SFR-121, H-03). 우리 병원으로 확정된 이송 건만.
// - 구급차 위치·지도·거리는 보여 주지 않고 도착 예상 시간만 (SFR-121 인수 기준, D-71)
// - 구급대 소속은 보여 주지 않는다 (절대 규칙 3)
// - 환자 요약은 열 수 있는 동안만 (도착 후 1시간까지, SER-014)
// 이벤트(incoming.*)에는 ID 만 오고, 화면은 받으면 이 API 로 다시 받는다 (절대 규칙 5)
import type pg from 'pg';
import { hreqCanViewPatient, type HreqStatus } from '../../domain/stateMachine.js';
import { assessmentFromRow, assessmentSelect, changedFields } from '../transport/assessment.js';
import { DISPLAY_ETA_SQL } from '../transport/navEta.js';
import { ambulanceNearEntrance } from './confirmArrival.js';

// 도착 뒤 이 시간까지 목록에 남긴다 (환자 정보 열람 1시간과 같게, SER-014)
const SHOW_AFTER_ARRIVAL = "interval '1 hour'";
// 도착 후 이 시간 안에만 '수용 불가'를 누를 수 있다 (SFR-158, 상태 전이표 A-2 47)
const UNACCEPTABLE_WINDOW_MS = 10 * 60_000;

const SEX: Record<string, string> = { M: '남', F: '여', U: '성별 확인 불가' };
// '60s' → '60대', '1-14' → '1~14세' (병원 웹 lib/assessment/labels.ts 와 같은 표기)
function ageText(band: string): string {
  if (band === 'under1') return '1세 미만';
  if (band === '90plus') return '90세 이상';
  const decade = /^(\d+)s$/.exec(band);
  if (decade) return `${decade[1]}대`;
  const range = /^(\d+)-(\d+)$/.exec(band);
  if (range) return `${range[1]}~${range[2]}세`;
  return band;
}

// '남·60대 · 뇌출혈 의심'. 값이 없는 칸은 뺀다
function summaryText(sex: string | null, ageBand: string | null, chief: string | null): string {
  const who = [sex ? SEX[sex] : null, ageBand ? ageText(ageBand) : null].filter(Boolean).join('·');
  return [who, chief].filter(Boolean).join(' · ');
}

interface IncomingRow extends Record<string, unknown> {
  id: string;
  status: HreqStatus;
  version: number;
  transport_id: string;
  location_consent: boolean;
  arrived_at: Date | null;
  extra_memo_at: Date | null;
  eta: number | null;
  sex: string | null;
  age_band: string | null;
  chief_complaint: string | null;
  server_now: Date;
}

export async function listIncoming(pool: pg.Pool, hospitalId: number) {
  const { rows } = await pool.query<IncomingRow>(
    `SELECT hr.id, hr.status, hr.version, hr.arrived_at, hr.extra_memo_at,
            t.id AS transport_id, t.location_consent,
            CASE WHEN hr.status = 'confirmed' AND t.status = 'moving' THEN ${DISPLAY_ETA_SQL} END AS eta,
            ${assessmentSelect('a')}, ${assessmentSelect('b', 'b_')},
            now() AS server_now
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       JOIN transport t ON t.id = r.transport_id
       -- 지금 환자 평가와, 이 병원이 요청을 받을 때 본 평가 (받은 뒤 바뀐 항목, SFR-105)
       LEFT JOIN LATERAL (
         SELECT * FROM assessment WHERE transport_id = r.transport_id ORDER BY seq DESC LIMIT 1
       ) a ON true
       LEFT JOIN LATERAL (
         SELECT * FROM assessment WHERE transport_id = r.transport_id
          ORDER BY (sent_at <= r.sent_at) DESC, CASE WHEN sent_at <= r.sent_at THEN seq ELSE -seq END DESC
          LIMIT 1
       ) b ON true
      WHERE hr.hospital_id = $1
        AND (hr.status = 'confirmed'
             OR (hr.status IN ('arrived', 'unacceptable') AND hr.arrived_at > now() - ${SHOW_AFTER_ARRIVAL}))
      -- 이동 중을 위에, 그 안에서는 먼저 도착할 환자부터. 도착한 환자는 최근 도착부터
      ORDER BY (hr.status = 'confirmed') DESC, eta NULLS LAST, hr.arrived_at DESC, hr.id`,
    [hospitalId],
  );
  const serverNow =
    rows[0]?.server_now ?? (await pool.query<{ now: Date }>('SELECT now()')).rows[0].now;

  const items = [];
  for (const row of rows) {
    const viewable = hreqCanViewPatient(row.status, serverNow, row.arrived_at);
    const moving = row.status === 'confirmed';
    // 위치 동의 건은 입구 200m 안일 때만 '도착 확인' (병원 웹 도착 확인과 같은 함수, SFR-144). 위치 없는 건은 항상
    const canConfirmArrival =
      moving &&
      (!row.location_consent ||
        (await ambulanceNearEntrance(pool, row.transport_id, hospitalId)) === true);
    items.push({
      id: Number(row.id),
      label: `R-${row.id}`,
      summary: viewable ? summaryText(row.sex, row.age_band, row.chief_complaint) : null,
      status: row.status as 'confirmed' | 'arrived' | 'unacceptable',
      version: row.version,
      etaMin: moving ? row.eta : null,
      hasLocation: row.location_consent,
      changedFields: viewable
        ? changedFields(assessmentFromRow(row, 'b_'), assessmentFromRow(row))
        : [],
      arrivedAt: row.arrived_at?.toISOString() ?? null,
      canConfirmArrival,
      canMarkUnacceptable:
        row.status === 'arrived' &&
        row.arrived_at !== null &&
        serverNow.getTime() - row.arrived_at.getTime() < UNACCEPTABLE_WINDOW_MS,
      extraMemoUsed: row.extra_memo_at !== null,
    });
  }
  return { items, serverNow: serverNow.toISOString() };
}
