// 병원 웹 요청 목록 (SFR-135, SFR-155, SER-014). 우리 병원에 온 요청만, 남은 시간 짧은 순.
// 구급대 소속(어느 소방서·안전센터인지)은 보여 주지 않는다 (절대 규칙 3, D-98)
import type pg from 'pg';
import { z } from 'zod';
import { hreqCanViewPatient, type HreqStatus } from '../../domain/stateMachine.js';

export const listQuerySchema = z.object({
  status: z.enum(['open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z
    .string()
    .regex(/^\d+_\d+$/)
    .optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

interface RequestRow {
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
  chief_complaint: string | null;
  server_now: Date;
}

// 다음 페이지 위치 = 마지막 행의 (마감 시각, id). 같은 마감 시각이 여러 개여도 id 로 이어 간다.
// DB 시각은 마이크로초까지 있어서 JS 시각(밀리초)으로 바꾸면 같은 행이 다시 나온다 → 마이크로초 정수로 둔다
const toCursor = (row: RequestRow) => `${row.until_us}_${row.id}`;
const UNTIL_US = '(extract(epoch FROM r.respond_until) * 1000000)::bigint';

export async function listRequests(pool: pg.Pool, hospitalId: number, query: ListQuery) {
  const [afterUs, afterId] = query.cursor ? query.cursor.split('_') : [null, null];
  const { rows } = await pool.query<RequestRow>(
    `SELECT hr.id, hr.status, hr.closed_reason, hr.eta_min, hr.eta_source, hr.prev_approved_recheck,
            hr.responder_name, hr.version, hr.arrived_at, r.respond_until,
            ${UNTIL_US}::text AS until_us, a.chief_complaint, now() AS server_now
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       LEFT JOIN LATERAL (
         SELECT chief_complaint FROM assessment
          WHERE transport_id = r.transport_id ORDER BY seq DESC LIMIT 1
       ) a ON true
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
    items: page.map((row) => ({
      id: Number(row.id),
      label: `R-${row.id}`,
      status: row.status,
      closeReason: row.closed_reason,
      // 닫힌·만료·거절 건은 결과만 준다. 환자 정보는 열 수 있는 요청만 (SER-014)
      chiefComplaint: hreqCanViewPatient(row.status, serverNow, row.arrived_at)
        ? row.chief_complaint
        : null,
      etaMin: row.eta_min,
      etaSource: row.eta_source,
      respondUntil: row.respond_until.toISOString(),
      // 정상 범위 판정 규칙(SFR-155)·바뀐 항목 표시(SFR-105)는 상세 화면 작업 때 채운다
      abnormalCount: null,
      prevApprovedRecheck: row.prev_approved_recheck,
      respondedBy: row.responder_name,
      updatedFields: [] as string[],
      version: row.version,
    })),
    nextCursor: rows.length > query.limit ? toCursor(page[page.length - 1]) : null,
    serverNow: serverNow.toISOString(),
  };
}
