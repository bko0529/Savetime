// 내 정보 (Me): 앱이 켜질 때 어느 화면을 열지 정하는 데 쓴다 (승인 대기·반려·근무 시작·이송 중).
import type pg from 'pg';

interface MeRow {
  id: string;
  name: string;
  rank: string;
  agency: string;
  safety_center: string;
  status: string;
  must_change_pw: boolean;
  reject_reason: string | null;
  applied_at: Date | null;
  team_id: string | null;
  has_active_transport: boolean;
}

// 반려 사유·신청 시각은 가장 최근 신청 1건만 본다 (재신청하면 새 행, SFR-083)
const ME_SQL = `
  SELECT p.id, p.name, p.rank, a.name AS agency, p.safety_center, p.status, p.must_change_pw,
         s.reject_reason, s.created_at AS applied_at, tm.team_id,
         EXISTS (
           SELECT 1 FROM transport t
            WHERE t.team_id = tm.team_id
              AND t.status IN ('requesting', 'fallback', 'phone_check', 'moving')
         ) AS has_active_transport
    FROM paramedic p
    JOIN agency a ON a.id = p.agency_id
    LEFT JOIN LATERAL (
      SELECT reject_reason, created_at FROM signup_request
       WHERE paramedic_id = p.id ORDER BY created_at DESC LIMIT 1
    ) s ON true
    LEFT JOIN team_member tm ON tm.paramedic_id = p.id AND tm.left_at IS NULL
   WHERE p.id = $1`;

export async function loadMe(db: pg.Pool | pg.PoolClient, paramedicId: string) {
  const { rows } = await db.query<MeRow>(ME_SQL, [paramedicId]);
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: Number(row.id),
    name: row.name,
    rank: row.rank,
    agency: row.agency,
    safetyCenter: row.safety_center,
    status: row.status,
    rejectReason: row.status === 'rejected' ? row.reject_reason : null,
    appliedAt: row.applied_at,
    mustChangePassword: row.must_change_pw,
    teamId: row.team_id === null ? null : Number(row.team_id),
    hasActiveTransport: row.has_active_transport,
  };
}
