// 병원 웹 요청 목록·상세 (SFR-135, SFR-118, SFR-137, SFR-155, SER-014). 우리 병원에 온 요청만.
// 구급대 소속(어느 소방서·안전센터인지)은 보여 주지 않는다 (절대 규칙 3, D-98)
import type pg from 'pg';
import { z } from 'zod';
import { abnormalFields } from '../../domain/abnormal.js';
import { hreqCanViewPatient, type HreqStatus } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import type { HospitalPc } from './pcAuth.js';

export const listQuerySchema = z.object({
  status: z.enum(['open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z
    .string()
    .regex(/^\d+_\d+$/)
    .optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

// 그 이송 건의 가장 최근 환자 평가 (변경 사항 보내기를 하면 seq 가 늘어난다)
const LATEST_ASSESSMENT = `LEFT JOIN LATERAL (
         SELECT * FROM assessment WHERE transport_id = r.transport_id ORDER BY seq DESC LIMIT 1
       ) a ON true`;
// 환자 평가 칸만 고른다 (전부 고르면 assessment.id 가 요청 id 와 섞인다)
const ASSESSMENT_COLUMNS = `a.chief_complaint, a.sex, a.age_band, a.consciousness, a.bp, a.pulse,
       a.resp, a.spo2, a.pain_site, a.pain_score, a.onset, a.trauma, a.trauma_cause, a.history,
       a.temp, a.glucose, a.ktas, a.unknown_fields`;

interface AssessmentRow {
  chief_complaint: string | null;
  sex: 'M' | 'F' | 'U' | null;
  age_band: string | null;
  consciousness: string | null;
  bp: string | null;
  pulse: number | null;
  resp: number | null;
  spo2: number | null;
  pain_site: string | null;
  pain_score: number | null;
  onset: string | null;
  trauma: string | null;
  trauma_cause: string | null;
  history: string | null;
  temp: string | null; // numeric 은 pg 가 문자열로 준다
  glucose: number | null;
  ktas: number | null;
  unknown_fields: string[] | null;
}

function toAssessment(a: AssessmentRow) {
  return {
    chiefComplaint: a.chief_complaint ?? '',
    sex: a.sex,
    ageBand: a.age_band,
    consciousness: a.consciousness,
    bp: a.bp,
    pulse: a.pulse,
    resp: a.resp,
    spo2: a.spo2,
    painSite: a.pain_site,
    painScore: a.pain_score,
    onset: a.onset,
    trauma: a.trauma,
    traumaCause: a.trauma_cause,
    history: a.history,
    temp: a.temp === null ? null : Number(a.temp),
    glucose: a.glucose,
    ktas: a.ktas,
    unknownFields: a.unknown_fields ?? [],
  };
}

interface RequestRow extends AssessmentRow {
  id: string;
  status: HreqStatus;
  closed_reason: string | null;
  eta_min: number | null;
  eta_source: 'straight' | 'route' | null;
  prev_approved_recheck: boolean;
  responder_name: string | null;
  version: number;
  arrived_at: Date | null;
  respond_until: Date;
  until_us: string;
  server_now: Date;
}

// 다음 페이지 위치 = 마지막 행의 (마감 시각, id). 같은 마감 시각이 여러 개여도 id 로 이어 간다.
// DB 시각은 마이크로초까지 있어서 JS 시각(밀리초)으로 바꾸면 같은 행이 다시 나온다 → 마이크로초 정수로 둔다
const toCursor = (row: RequestRow) => `${row.until_us}_${row.id}`;
const UNTIL_US = '(extract(epoch FROM r.respond_until) * 1000000)::bigint';

export async function listRequests(pool: pg.Pool, hospitalId: number, query: ListQuery) {
  const [afterUs, afterId] = query.cursor ? query.cursor.split('_') : [null, null];
  const { rows } = await pool.query<RequestRow>(
    `SELECT ${ASSESSMENT_COLUMNS}, hr.id, hr.status, hr.closed_reason, hr.eta_min, hr.eta_source,
            hr.prev_approved_recheck, hr.responder_name, hr.version, hr.arrived_at, r.respond_until,
            ${UNTIL_US}::text AS until_us, now() AS server_now
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       ${LATEST_ASSESSMENT}
      WHERE hr.hospital_id = $1
        -- 전달 못 한 요청은 병원이 받은 적이 없다
        AND hr.status <> 'delivery_failed'
        AND (
          -- 대기는 마감 전까지만 (타이머가 조금 늦어도 마감 지난 요청으로 알림음이 울리지 않게)
          (hr.status = 'waiting' AND r.respond_until > now())
          OR hr.status = 'approved'
          -- all: 오늘(한국 시각) 처리한 이력도 같이
          OR ($2 = 'all' AND r.sent_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')
        )
        AND ($3::bigint IS NULL OR (${UNTIL_US}, hr.id) > ($3::bigint, $4::bigint))
      ORDER BY r.respond_until, hr.id
      LIMIT $5`,
    [hospitalId, query.status, afterUs, afterId, query.limit + 1],
  );

  const page = rows.slice(0, query.limit);
  const serverNow =
    rows[0]?.server_now ?? (await pool.query<{ now: Date }>('SELECT now()')).rows[0].now;
  return {
    items: page.map((row) => {
      // 닫힌·만료·거절 건은 결과만 준다. 환자 정보는 열 수 있는 요청만 (SER-014)
      const viewable = hreqCanViewPatient(row.status, serverNow, row.arrived_at);
      const assessment = toAssessment(row);
      return {
        id: Number(row.id),
        label: `R-${row.id}`,
        status: row.status,
        closeReason: row.closed_reason,
        chiefComplaint: viewable ? row.chief_complaint : null,
        etaMin: row.eta_min,
        etaSource: row.eta_source,
        respondUntil: row.respond_until.toISOString(),
        // 몇 개가 정상 범위 밖인지만. 순서는 바꾸지 않는다 (SFR-155, D-38)
        abnormalCount: viewable ? abnormalFields(assessment).length : null,
        prevApprovedRecheck: row.prev_approved_recheck,
        respondedBy: row.responder_name,
        // 바뀐 항목 표시(SFR-105)는 '변경 사항 보내기'가 생기면 채운다
        updatedFields: [] as string[],
        version: row.version,
      };
    }),
    nextCursor: rows.length > query.limit ? toCursor(page[page.length - 1]) : null,
    serverNow: serverNow.toISOString(),
  };
}

interface DetailRow extends RequestRow {
  hospital_id: string;
  memo: string | null;
  extra_memo: string | null;
}

// 병상 '가용/전체'. 수집된 값이 없으면 null
const bedText = (avail: number | null, total: number | null) =>
  avail === null || total === null ? null : `${avail}/${total}`;

// 요청 상세 (SFR-118). 열 때마다 열람 기록을 남긴다 (SFR-137)
export async function getRequestDetail(pool: pg.Pool, pc: HospitalPc, requestId: number) {
  const { rows } = await pool.query<DetailRow>(
    `SELECT ${ASSESSMENT_COLUMNS}, hr.id, hr.hospital_id, hr.status, hr.closed_reason, hr.eta_min, hr.eta_source,
            hr.prev_approved_recheck, hr.responder_name, hr.memo, hr.extra_memo, hr.version, hr.arrived_at,
            r.respond_until, now() AS server_now
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       ${LATEST_ASSESSMENT}
      WHERE hr.id = $1`,
    [requestId],
  );
  const row = rows[0];
  // 다른 병원 요청은 있는지조차 알려 주지 않는다 (SER-013)
  if (!row || Number(row.hospital_id) !== pc.hospitalId) {
    throw new AppError(404, 'NOT_FOUND', '요청을 찾을 수 없어요');
  }

  // 열람 기록에 '누가' 봤는지 남겨야 해서 근무(담당자 이름)가 있어야 연다 (SFR-137)
  const { rows: shifts } = await pool.query<{ staff_name: string }>(
    `SELECT staff_name FROM hospital_shift
      WHERE pc_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [pc.pcId],
  );
  if (!shifts[0]) throw new AppError(409, 'SHIFT_REQUIRED', '근무를 먼저 시작해 주세요');

  // 닫힌·만료·거절 건, 도착 후 1시간이 지난 건은 환자 정보를 주지 않는다 (SER-014)
  if (!hreqCanViewPatient(row.status, row.server_now, row.arrived_at)) {
    throw new AppError(409, 'REQUEST_CLOSED', '이미 끝난 요청이에요', { status: row.status });
  }

  // 열람 기록은 고치거나 지울 수 없다 (DB 규칙, DAR-011)
  await pool.query(
    'INSERT INTO request_view_log (hospital_request_id, pc_id, staff_name) VALUES ($1, $2, $3)',
    [requestId, pc.pcId, shifts[0].staff_name],
  );

  const [{ rows: beds }, { rows: approvals }] = await Promise.all([
    pool.query<{
      er_avail: number | null;
      er_total: number | null;
      icu_avail: number | null;
      icu_total: number | null;
      or_avail: number | null;
      or_total: number | null;
    }>(
      'SELECT er_avail, er_total, icu_avail, icu_total, or_avail, or_total FROM bed_current WHERE hospital_id = $1',
      [pc.hospitalId],
    ),
    // 지금 유효한 우리 병원 승인 수 (과승인 경고용, SFR-154)
    pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM hospital_request hr
         JOIN request_round r ON r.id = hr.round_id
        WHERE hr.hospital_id = $1 AND hr.status = 'approved' AND r.approval_valid_until > now()`,
      [pc.hospitalId],
    ),
  ]);
  const bed = beds[0];
  const assessment = toAssessment(row);

  return {
    id: Number(row.id),
    label: `R-${row.id}`,
    version: row.version,
    status: row.status,
    respondUntil: row.respond_until.toISOString(),
    serverNow: row.server_now.toISOString(),
    assessment,
    abnormalFields: abnormalFields(assessment),
    updatedFields: [] as string[],
    etaMin: row.eta_min,
    etaSource: row.eta_source,
    prevApprovedRecheck: row.prev_approved_recheck,
    ourHospital: {
      // 증상별 진료 가능 표시는 v1.5 에서 뺐다 (CR-007, D-130)
      capability: null,
      beds: {
        er: bed ? bedText(bed.er_avail, bed.er_total) : null,
        icu: bed ? bedText(bed.icu_avail, bed.icu_total) : null,
        or: bed ? bedText(bed.or_avail, bed.or_total) : null,
      },
    },
    validApprovals: approvals[0].n,
    respondedBy: row.responder_name,
    memo: row.memo,
    // 확정 뒤 보낸 추가 메모 (SFR-140). 값이 있으면 화면이 '추가 메모' 버튼을 숨긴다
    extraMemo: row.extra_memo,
  };
}
