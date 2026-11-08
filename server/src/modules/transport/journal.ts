// 구급활동일지 초안의 자동 항목 (SFR-164, 부록 G).
// - 따로 저장하지 않고 부를 때마다 이송 건 기록에서 조립한다 (DAR-015)
// - 이송이 끝난 뒤 10분 안에만 준다. 그 뒤로는 팀과 이송 건의 연결을 잊는다는 약속이다 (DAR-013). 판정은 DB now() (규칙 6)
// - 환자 성명·주소·연락처·생년월일은 서버에 없다. 앱이 단말에서만 입력·보관한다 (SER-012, DAR-015)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { AppError } from '../../http/errors.js';
import { paramedicAuth } from '../auth/guards.js';
import { transportIdParam, transportNotFound } from './access.js';

// 종료 뒤 팀 연결을 기억하는 시간 (DAR-013)
export const JOURNAL_WINDOW_MINUTES = 10;

// 앱 평가 입력 값 → 일지 의식 상태 칸 (AVPU). '확인 불가'는 빈칸으로 두고 대원이 쓴다
const AVPU: Record<string, 'A' | 'V' | 'P' | 'U'> = {
  alert: 'A',
  verbal: 'V',
  pain: 'P',
  unresponsive: 'U',
};

// 혈압은 '150/90'처럼 저장돼 있다. 일지는 수축기·이완기 칸이 따로라 나눈다. 모양이 다르면 빈칸
function splitBp(bp: string | null): { sbp: number | null; dbp: number | null } {
  const match = bp?.match(/^\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*$/);
  return match ? { sbp: Number(match[1]), dbp: Number(match[2]) } : { sbp: null, dbp: null };
}

interface TransportRow {
  team_id: string;
  status: string;
  ended: boolean;
  expired: boolean;
  departed_at: Date | null;
  arrived_at: Date | null;
  distance_m: number | null;
  cancel_reason: string | null;
  not_transported_reason: string | null;
  not_transported_text: string | null;
  hospital_name: string | null;
  allowed: boolean;
}

export async function buildJournalDraft(pool: pg.Pool, transportId: string, paramedicId: string) {
  // 부른 대원이 이 이송 건이 진행되는 동안 그 팀에 있었는지(allowed)도 같이 본다
  const { rows } = await pool.query<TransportRow>(
    `SELECT t.team_id, t.status,
            t.status IN ('arrived','cancelled') AS ended,
            coalesce(t.arrived_at, t.cancelled_at) < now() - make_interval(mins => $3) AS expired,
            t.departed_at, t.arrived_at, t.distance_m, t.cancel_reason,
            t.not_transported_reason, t.not_transported_text,
            h.name AS hospital_name,
            EXISTS (SELECT 1 FROM team_member m
                     WHERE m.team_id = t.team_id AND m.paramedic_id = $2
                       AND m.joined_at <= coalesce(t.arrived_at, t.cancelled_at, now())
                       AND (m.left_at IS NULL OR m.left_at >= t.created_at)) AS allowed
       FROM transport t
       LEFT JOIN hospital h ON h.id = t.confirmed_hospital_id AND t.status = 'arrived'
      WHERE t.id = $1`,
    [transportId, paramedicId, JOURNAL_WINDOW_MINUTES],
  );
  const t = rows[0];
  // 남의 이송 건·10분이 지난 건은 있는지조차 알리지 않는다 (SER-010, DAR-013)
  if (!t || !t.team_id || !t.allowed) throw transportNotFound();
  if (!t.ended) {
    throw new AppError(409, 'TRANSPORT_NOT_ENDED', '이송이 끝난 뒤에 일지 초안을 볼 수 있어요');
  }
  if (t.expired) throw transportNotFound();

  // 소방서·안전센터는 부른 대원의 소속 (같은 구급차라 같은 소방서)
  const { rows: me } = await pool.query<{ agency_name: string; safety_center: string }>(
    `SELECT a.name AS agency_name, p.safety_center
       FROM paramedic p JOIN agency a ON a.id = p.agency_id WHERE p.id = $1`,
    [paramedicId],
  );
  // 구급대원: 이송이 진행되는 동안 팀에 있었던 사람 (중간에 빠진 사람도, 끝난 뒤 들어온 사람은 빼고)
  const { rows: crew } = await pool.query<{ name: string; rank: string; role: 'driver' | 'care' }>(
    `SELECT DISTINCT ON (m.paramedic_id) p.name, p.rank, m.role, m.joined_at
       FROM team_member m
       JOIN transport t ON t.id = $1
       JOIN paramedic p ON p.id = m.paramedic_id
      WHERE m.team_id = t.team_id
        AND m.joined_at <= coalesce(t.arrived_at, t.cancelled_at)
        AND (m.left_at IS NULL OR m.left_at >= t.created_at)
      ORDER BY m.paramedic_id, m.joined_at DESC`,
    [transportId],
  );
  // 마지막으로 병원에 보낸 평가 (변경 사항 보내기까지 반영). 보관 기간이 지나 지운 것은 없음
  const { rows: assessments } = await pool.query<{
    sex: 'M' | 'F' | 'U' | null;
    age_band: string | null;
    chief_complaint: string | null;
    onset: string | null;
    consciousness: string | null;
    bp: string | null;
    pulse: number | null;
    resp: number | null;
    spo2: number | null;
    temp: string | null;
    glucose: number | null;
    history: string | null;
    ktas: number | null;
  }>(
    `SELECT sex, age_band, chief_complaint, onset, consciousness, bp, pulse, resp, spo2,
            temp, glucose, history, ktas
       FROM assessment
      WHERE transport_id = $1 AND purged_at IS NULL
      ORDER BY seq DESC LIMIT 1`,
    [transportId],
  );
  // 재이송 사유: 이 이송 건에서 병원이 거절·승인 취소·수용 불가한 것 + 전화 확인 거절.
  // '잠시 요청 중지' 자동 거절(paused)은 병원이 환자를 보고 거절한 게 아니라 뺀다
  const { rows: reTransfer } = await pool.query<{ hospital_name: string; reason: string }>(
    `SELECT hospital_name, reason FROM (
       SELECT h.name AS hospital_name, hr.reason, hr.responded_at AS at, hr.id AS ord
         FROM hospital_request hr
         JOIN request_round r ON r.id = hr.round_id
         JOIN hospital h ON h.id = hr.hospital_id
        WHERE r.transport_id = $1 AND hr.reason IS NOT NULL AND hr.reason <> 'paused'
       UNION ALL
       SELECT h.name, coalesce(pc.reject_reason, 'etc'), pc.created_at, pc.id
         FROM phone_check pc
         JOIN hospital h ON h.id = pc.hospital_id
        WHERE pc.transport_id = $1 AND pc.result = 'rejected'
     ) x
     ORDER BY at NULLS LAST, ord`,
    [transportId],
  );

  const a = assessments[0];
  const bp = splitBp(a?.bp ?? null);
  return {
    transportId,
    agencyName: me[0].agency_name,
    safetyCenter: me[0].safety_center,
    crew: crew.map((c) => ({ name: c.name, rank: c.rank, role: c.role })),
    departedAt: t.departed_at,
    arrivedAt: t.arrived_at,
    // 위치 기록이 없으면(위치 미동의·통신 두절 중 도착) 빈칸 → 대원이 직접 입력 (SFR-164)
    distanceKm: t.distance_m === null ? null : Math.round(t.distance_m / 100) / 10,
    // '확인 불가'(U)는 빈칸
    sex: a?.sex === 'M' || a?.sex === 'F' ? a.sex : null,
    ageBand: a?.age_band ?? null,
    chiefComplaint: a?.chief_complaint ?? null,
    onsetAt: a?.onset ?? null,
    consciousness: (a?.consciousness && AVPU[a.consciousness]) || null,
    vitals: {
      sbp: bp.sbp,
      dbp: bp.dbp,
      pulse: a?.pulse ?? null,
      resp: a?.resp ?? null,
      temp: a?.temp === null || a?.temp === undefined ? null : Number(a.temp),
      spo2: a?.spo2 ?? null,
      glucose: a?.glucose ?? null,
    },
    history: a?.history ?? null,
    ktas: a?.ktas ?? null,
    // 이송 기관: 도착한 건만 (취소된 건은 이송하지 않았다)
    hospitalName: t.hospital_name,
    reTransferReasons: reTransfer.map((r) => ({ hospitalName: r.hospital_name, reason: r.reason })),
    // 미이송 사유: 대원이 고른 것. 서버가 끝낸 취소(활동 없음·근무 종료 등)는 system_end
    notTransportedReason:
      t.status !== 'cancelled'
        ? null
        : t.cancel_reason === 'user'
          ? t.not_transported_reason
          : 'system_end',
    notTransportedText: t.status === 'cancelled' ? t.not_transported_text : null,
  };
}

export function journalRouter(pool: pg.Pool, guards: RequestHandler[]): Router {
  const router = Router();
  router.get('/transports/:transportId/journal-draft', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    res.json(await buildJournalDraft(pool, transportId, paramedicAuth(res).paramedicId));
  });
  return router;
}
