// 요청·응답 통계 기록 (SFR-126, D-115). 집계 화면(SFR-106)이 읽을 원장만 쌓는다.
// 두 테이블 모두 이송 건 ID·대원 계정 칸이 없다: 통계는 '어느 병원이 무슨 사유로' 까지만 남긴다 (DAR-004).
// 늘 호출한 쪽 트랜잭션 안에서 쓴다. 거절이 롤백되면 기록도 같이 사라져야 수치가 실제와 맞는다.
import type pg from 'pg';

export type RejectionSource =
  'hospital_web' | 'paused' | 'phone_check' | 'approval_cancelled' | 'unacceptable';

export interface RejectionInput {
  transportId: string; // 고른 등급을 읽는 데만 쓰고 저장하지 않는다
  hospitalId: number | string;
  source: RejectionSource;
  reason: string | null;
  reasonText: string | null;
}

// 거절 1건 = 1줄. 병원 거절 통계 기본 수치는 승언님 쿼리에서 source = 'hospital_web' 만 센다
export async function recordRejection(client: pg.PoolClient, input: RejectionInput) {
  await client.query(
    `INSERT INTO rejection_record (hospital_id, source, reason, reason_text, requested_grade)
     SELECT $2, $3, $4, $5, t.requested_grade FROM transport t WHERE t.id = $1`,
    [input.transportId, input.hospitalId, input.source, input.reason, input.reasonText],
  );
}

// 이송이 끝날 때(도착·취소·이전 건 마무리) 소요시간 1줄. 요청을 한 번도 안 보낸 건은 남기지 않는다.
// 기준 시각은 '첫 회차 요청 시각': 다시 요청해도 대원이 처음 요청한 때부터 잰다 (SFR-126 인수 기준)
export async function recordTransportStat(client: pg.PoolClient, transportId: string) {
  await client.query(
    `WITH first_round AS (
       SELECT min(sent_at) AS sent_at FROM request_round WHERE transport_id = $1
     ), first_approval AS (
       -- 승인한 요청 = 응답 시각이 있고 거절이 아닌 것 (승인 뒤 확정·도착·승인 취소·수용 불가가 돼도 응답 시각은 남는다)
       SELECT min(hr.responded_at) AS at
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $1 AND hr.responded_at IS NOT NULL AND hr.status <> 'rejected'
     )
     INSERT INTO transport_stat (hospital_id, request_to_approve_sec, request_to_depart_sec,
                                 departed_at, arrived_at, duration_sec, distance_m)
     SELECT t.confirmed_hospital_id,
            round(extract(epoch FROM a.at - f.sent_at))::int,
            -- 출발 = 처음 병원을 확정하고 출발한 시각. 다시 요청·목적지 변경 뒤에도 바뀌지 않는다 (SFR-036)
            round(extract(epoch FROM t.departed_at - f.sent_at))::int,
            t.departed_at, t.arrived_at,
            round(extract(epoch FROM t.arrived_at - t.departed_at))::int,
            t.distance_m
       FROM transport t, first_round f, first_approval a
      WHERE t.id = $1 AND f.sent_at IS NOT NULL`,
    [transportId],
  );
}
