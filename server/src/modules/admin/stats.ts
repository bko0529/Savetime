// 관리자 병원 응답 통계 (SFR-106, A-02). 기간(최근 7일·30일)을 골라 병원별로 본다.
// ① 응답률 ② 평균 응답 시간 — 병원 웹에서 직접 누른 응답만 (잠시 요청 중지 자동 거절 in_stats=false 는 뺀다, SFR-126)
// ③ 거절 사유별 건수 — 거절 원장(rejection_record)을 출처별로 (병원 웹 직접·요청 중지·전화 확인·승인 취소·수용 불가)
// ④ 승인 취소율 — (승인 취소 + 수용 불가) ÷ 승인 건수 (SFR-158)
// ⑤ 평균 '요청→첫 승인'·'요청→출발' — 이송이 끝날 때 쌓는 익명 소요시간(transport_stat)
// 기간 안 요청이 10건 미만이면 수치 대신 '표본 부족'. 7일 거절률이 30일보다 20%p 이상 높으면 강조.
// 대원 계정·이송 건은 어디에도 내보내지 않는다 (DAR-004). 기간 판정은 DB now() (규칙 6)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { parseBody } from '../../http/validate.js';

export const MIN_SAMPLE = 10;
export const SPIKE_POINTS = 0.2;

const querySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => d === 7 || d === 30)
    .default(7),
});

// 거절 원장 출처 → 응답의 칸 이름
const SOURCE_KEY = {
  hospital_web: 'hospitalWeb',
  paused: 'paused',
  phone_check: 'phoneCheck',
  approval_cancelled: 'approvalCancelled',
  unacceptable: 'unacceptable',
} as const;
type SourceKey = (typeof SOURCE_KEY)[keyof typeof SOURCE_KEY];

interface HospitalRow {
  hospital_id: string;
  name: string;
  requests: number;
  answered: number;
  rejected: number;
  avg_response_sec: number | null;
  requests7: number;
  rejected7: number;
  requests30: number;
  rejected30: number;
}

// 병원에 '닿은' 요청: 전달 실패와 아직 2분이 안 끝난 대기, 요청 중지 자동 거절은 뺀다
const COUNTED_REQUESTS = `
  SELECT hr.hospital_id, r.sent_at, hr.status, hr.responded_at
    FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
   WHERE hr.in_stats
     AND hr.status <> 'delivery_failed'
     AND NOT (hr.status = 'waiting' AND r.respond_until > now())
     AND r.sent_at > now() - interval '30 days'`;

export function adminStatsRouter(pool: pg.Pool, adminOnly: RequestHandler): Router {
  const router = Router();

  router.get('/admin/stats/hospitals', adminOnly, async (req, res) => {
    const { days } = parseBody(querySchema, req.query);

    // 고른 기간의 수치 + 거절률 급등을 보려고 7일·30일 수치를 함께 센다
    const { rows: hospitals } = await pool.query<HospitalRow>(
      `WITH counted AS (${COUNTED_REQUESTS})
       SELECT c.hospital_id, h.name,
              count(*) FILTER (WHERE c.sent_at > now() - make_interval(days => $1))::int AS requests,
              count(*) FILTER (WHERE c.sent_at > now() - make_interval(days => $1)
                                 AND c.responded_at IS NOT NULL)::int AS answered,
              count(*) FILTER (WHERE c.sent_at > now() - make_interval(days => $1)
                                 AND c.status = 'rejected')::int AS rejected,
              round(avg(extract(epoch FROM c.responded_at - c.sent_at))
                    FILTER (WHERE c.sent_at > now() - make_interval(days => $1)
                              AND c.responded_at IS NOT NULL))::int AS avg_response_sec,
              count(*) FILTER (WHERE c.sent_at > now() - interval '7 days')::int AS requests7,
              count(*) FILTER (WHERE c.sent_at > now() - interval '7 days'
                                 AND c.status = 'rejected')::int AS rejected7,
              count(*)::int AS requests30,
              count(*) FILTER (WHERE c.status = 'rejected')::int AS rejected30
         FROM counted c JOIN hospital h ON h.id = c.hospital_id
        GROUP BY c.hospital_id, h.name
       HAVING count(*) FILTER (WHERE c.sent_at > now() - make_interval(days => $1)) > 0
        ORDER BY h.name`,
      [days],
    );

    // 거절 원장: 병원·출처·사유별 건수
    const { rows: rejections } = await pool.query<{
      hospital_id: string;
      source: keyof typeof SOURCE_KEY;
      reason: string | null;
      n: number;
    }>(
      `SELECT hospital_id, source, coalesce(reason, 'etc') AS reason, count(*)::int AS n
         FROM rejection_record
        WHERE created_at > now() - make_interval(days => $1)
        GROUP BY hospital_id, source, coalesce(reason, 'etc')`,
      [days],
    );

    // 익명 소요시간: 병원별·전체 평균 (출발 시각이 기간 안인 이송)
    const { rows: times } = await pool.query<{
      hospital_id: string | null;
      to_approve: number | null;
      to_depart: number | null;
    }>(
      `SELECT hospital_id,
              round(avg(request_to_approve_sec))::int AS to_approve,
              round(avg(request_to_depart_sec))::int AS to_depart
         FROM transport_stat
        WHERE coalesce(departed_at, arrived_at) > now() - make_interval(days => $1)
          AND hospital_id IS NOT NULL
        GROUP BY hospital_id`,
      [days],
    );
    // 맨 위 핵심 지표 '요청→출발' 전체 평균 (병원이 정해지기 전에 끝난 건도 포함)
    const { rows: overall } = await pool.query<{ to_depart: number | null }>(
      `SELECT round(avg(request_to_depart_sec))::int AS to_depart FROM transport_stat
        WHERE coalesce(departed_at, arrived_at) > now() - make_interval(days => $1)`,
      [days],
    );
    const timeOf = new Map(times.map((t) => [t.hospital_id!, t]));

    res.json({
      days,
      avgRequestToDepartSec: overall[0]?.to_depart ?? null,
      hospitals: hospitals.map((h) => {
        const mine = rejections.filter((r) => r.hospital_id === h.hospital_id);
        const bySource: Record<SourceKey, Record<string, number>> = {
          hospitalWeb: {},
          paused: {},
          phoneCheck: {},
          approvalCancelled: {},
          unacceptable: {},
        };
        for (const r of mine) bySource[SOURCE_KEY[r.source]][r.reason ?? 'etc'] = r.n;
        // 대표 거절 사유: 병원 웹 직접 거절에서 가장 많은 것 (기본 수치는 병원 웹 직접만, SFR-126)
        const top = Object.entries(bySource.hospitalWeb).sort((a, b) => b[1] - a[1])[0];
        const cancelled = mine
          .filter((r) => r.source === 'approval_cancelled' || r.source === 'unacceptable')
          .reduce((s, r) => s + r.n, 0);
        const unacceptableCount = mine
          .filter((r) => r.source === 'unacceptable')
          .reduce((s, r) => s + r.n, 0);
        const approved = h.answered - h.rejected;
        const small = h.requests < MIN_SAMPLE;
        // 급등: 7일·30일 둘 다 표본이 충분할 때만 판단한다
        const rate = (rejected: number, requests: number) => (requests ? rejected / requests : 0);
        const spike =
          h.requests7 >= MIN_SAMPLE &&
          h.requests30 >= MIN_SAMPLE &&
          rate(h.rejected7, h.requests7) - rate(h.rejected30, h.requests30) >= SPIKE_POINTS - 1e-9;
        const t = timeOf.get(h.hospital_id);
        return {
          hospitalId: Number(h.hospital_id),
          name: h.name,
          requests: h.requests,
          sampleTooSmall: small,
          // 표본이 작으면 수치를 주지 않는다 (화면은 '표본 부족')
          responseRate: small ? null : h.answered / h.requests,
          avgResponseSec: small ? null : h.avg_response_sec,
          topRejectReason: top ? top[0] : null,
          approvalCancelRate: small || approved === 0 ? null : cancelled / approved,
          unacceptableCount,
          avgRequestToFirstApprovalSec: small ? null : (t?.to_approve ?? null),
          avgRequestToDepartSec: small ? null : (t?.to_depart ?? null),
          rejectSpike: spike,
          rejectBySource: bySource,
        };
      }),
    });
  });

  return router;
}
