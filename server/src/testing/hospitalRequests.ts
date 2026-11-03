// 병원 요청 만들기 (테스트·개발용). 실제로는 대원 앱의 '병원에 요청'(이송 건 만들기)이 만든다.
// 팀·대원 없이 이송 건 1개 → 회차 1개 → 병원 요청 1개를 바로 넣는다.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { HreqStatus } from '../domain/stateMachine.js';

export async function addHospitalRequest(
  pool: pg.Pool,
  hospitalId: number | string,
  {
    status = 'waiting' as HreqStatus,
    // 응답 마감까지 남은 시간 (PostgreSQL interval, 음수면 이미 지남)
    respondIn = '2 minutes',
    chiefComplaint = '흉통',
    closedReason = null as string | null,
    // assessment 칸 이름(DB) → 값. 예: { spo2: 86, age_band: '60s' }
    assessment = {} as Record<string, string | number | null>,
    arrivedAgo = null as string | null,
  } = {},
): Promise<number> {
  const transportId = randomUUID();
  await pool.query('INSERT INTO transport (id, location_consent) VALUES ($1, true)', [transportId]);
  // 칸 이름은 테스트 코드가 정한 고정 값만 들어온다
  const columns = Object.keys(assessment);
  await pool.query(
    `INSERT INTO assessment (transport_id, seq, chief_complaint${columns.map((c) => `, ${c}`).join('')})
     VALUES ($1, 1, $2${columns.map((_, i) => `, $${i + 3}`).join('')})`,
    [transportId, chiefComplaint, ...Object.values(assessment)],
  );
  const { rows: rounds } = await pool.query<{ id: string }>(
    `INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
     VALUES ($1, 1, 20, now() + $2::interval - interval '2 minutes',
             now() + $2::interval, now() + $2::interval + interval '3 minutes')
     RETURNING id`,
    [transportId, respondIn],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_request (round_id, hospital_id, status, closed_reason, eta_min, eta_source, arrived_at)
     VALUES ($1, $2, $3, $4, 9, 'straight', now() - $5::interval) RETURNING id`,
    [rounds[0].id, hospitalId, status, closedReason, arrivedAgo],
  );
  return Number(rows[0].id);
}
