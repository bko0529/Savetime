// 관리자 대원 계정 관리 (SFR-151, A-01): 대원 검색 · 정지(즉시 로그아웃) · 정지 해제.
// 팀에서 빼고 마지막 1명이면 진행 중 이송을 취소하는 일은 근무 끝내기(endDuty)가 맡는다.
// 이송 상태 변경은 그 안에서 stateMachine.ts 를 거친다 (절대 규칙 4)
import { Router, type RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { ACTIVE } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { forgetSessionState } from '../auth/session.js';
import type { Realtime } from '../realtime/server.js';
import { endDuty } from '../team/endDuty.js';
import { adminId } from './auth.js';
import { recordAudit } from './audit.js';

const searchSchema = z.object({
  q: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().regex(/^\d+$/).optional(),
});
const idParams = z.object({ id: z.coerce.number().int().positive() });

// 정지 사유 4가지 (SFR-151). 기타는 직접 쓴 내용을 작업 이력에 남긴다
export const SUSPEND_REASONS = {
  retired: '퇴직',
  phone_lost: '폰 분실',
  misuse: '부정 사용',
  etc: '기타',
} as const;
const suspendSchema = z.object({
  reason: z.enum(Object.keys(SUSPEND_REASONS) as [keyof typeof SUSPEND_REASONS]),
  etcText: z.string().trim().max(50).nullish(),
  confirmCancelActive: z.boolean().optional(),
});

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const notFound = () => new AppError(404, 'NOT_FOUND', '대원 계정을 찾을 수 없어요');

interface ParamedicRow {
  id: string;
  name: string;
  status: string;
}

// 대원 행을 잠그고 읽는다. 탈퇴한 계정은 없는 것으로 본다
async function lockParamedic(client: pg.PoolClient, id: number): Promise<ParamedicRow> {
  const { rows } = await client.query<ParamedicRow>(
    'SELECT id, name, status FROM paramedic WHERE id = $1 FOR UPDATE',
    [id],
  );
  const row = rows[0];
  if (!row || row.status === 'withdrawn') throw notFound();
  return row;
}

export function adminParamedicRouter(
  pool: pg.Pool,
  redis: Redis,
  adminOnly: RequestHandler,
  realtime?: Pick<Realtime, 'publish' | 'forceLogoutParamedic'>,
): Router {
  const router = Router();

  // 대원 검색: 이름·사번 일부로 찾는다. 소속·상태·진행 중 이송 여부를 같이 보여 준다 (정지 전 경고용)
  router.get('/admin/paramedics', adminOnly, async (req, res) => {
    const q = parseBody(searchSchema, req.query);
    const { rows } = await pool.query<{
      id: string;
      name: string;
      agency_name: string;
      safety_center: string;
      employee_no: string;
      status: string;
      has_active: boolean;
    }>(
      `SELECT p.id, p.name, a.name AS agency_name, p.safety_center, p.employee_no, p.status,
              EXISTS (
                SELECT 1 FROM team_member tm JOIN transport t ON t.team_id = tm.team_id
                 WHERE tm.paramedic_id = p.id AND tm.left_at IS NULL
                   AND t.status = ANY($4::transport_status[])
              ) AS has_active
         FROM paramedic p JOIN agency a ON a.id = p.agency_id
        WHERE p.status <> 'withdrawn'
          AND ($1::text IS NULL OR p.name ILIKE '%' || $1 || '%' OR p.employee_no ILIKE '%' || $1 || '%')
          AND ($2::bigint IS NULL OR p.id > $2)
        ORDER BY p.id
        LIMIT $3`,
      [q.q ? likeEscape(q.q) : null, q.cursor ?? null, q.limit + 1, ACTIVE],
    );
    const page = rows.slice(0, q.limit);
    res.json({
      items: page.map((p) => ({
        id: Number(p.id),
        name: p.name,
        agencyName: p.agency_name,
        safetyCenter: p.safety_center,
        employeeNo: p.employee_no,
        status: p.status,
        hasActiveTransport: p.has_active,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    });
  });

  // 정지: 로그인을 바로 끊고 막는다. 진행 중 이송이 있으면 관리자 확인(confirmCancelActive)을 먼저 받는다
  router.post('/admin/paramedics/:id/suspend', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const input = parseBody(suspendSchema, req.body);
    // 작업 이력 사유: 기타는 쓴 내용이 있으면 그것을
    const reasonText =
      input.reason === 'etc' && input.etcText ? input.etcText : SUSPEND_REASONS[input.reason];

    const outcome = await withTransaction(pool, async (client) => {
      const p = await lockParamedic(client, id);
      // 이미 정지된 계정이면 아무것도 바꾸지 않고 이력도 두 번 남기지 않는다
      if (p.status === 'suspended') return null;
      // 승인된 계정만 정지한다. 승인 대기·반려는 가입 승인(SFR-083)에서 다룬다
      if (p.status !== 'approved') {
        throw new AppError(409, 'INVALID_TRANSITION', '승인된 계정만 정지할 수 있어요');
      }
      // 팀에서 빠짐 + 마지막 1명이면 이송 취소(사유 suspended) + 로그인 토큰 모두 폐기.
      // 확인 없이 진행 중 이송이 있으면 여기서 409 ACTIVE_TRANSPORT_CONFIRM_REQUIRED (롤백)
      const { events } = await endDuty(
        client,
        { redis },
        p.id,
        'suspended',
        input.confirmCancelActive === true,
      );
      await client.query("UPDATE paramedic SET status = 'suspended' WHERE id = $1", [p.id]);
      await recordAudit(client, {
        adminId: adminId(res),
        action: 'suspend_paramedic',
        targetType: 'paramedic',
        targetId: p.id,
        targetName: p.name,
        reason: reasonText,
      });
      return { paramedicId: p.id, events };
    });

    if (outcome) {
      // 커밋한 뒤에: 취소된 이송 이벤트 → 캐시 지우기(다음 요청부터 바로 막힘) → 앱 강제 로그아웃
      realtime?.publish(outcome.events);
      await forgetSessionState({ redis }, outcome.paramedicId);
      await realtime?.forceLogoutParamedic(outcome.paramedicId, 'suspended');
    }
    res.status(204).end();
  });

  // 정지 해제: 다시 로그인할 수 있다. 팀·이송은 되돌리지 않는다 (새로 근무를 시작한다)
  router.post('/admin/paramedics/:id/unsuspend', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const changed = await withTransaction(pool, async (client) => {
      const p = await lockParamedic(client, id);
      if (p.status !== 'suspended') return null;
      // 정지 중에 비밀번호를 틀려 잠긴 기록이 있어도 해제하면 처음부터 다시 센다
      await client.query(
        `UPDATE paramedic SET status = 'approved', failed_count = 0, locked_until = NULL
          WHERE id = $1`,
        [p.id],
      );
      await recordAudit(client, {
        adminId: adminId(res),
        action: 'unsuspend_paramedic',
        targetType: 'paramedic',
        targetId: p.id,
        targetName: p.name,
      });
      return p.id;
    });
    if (changed) await forgetSessionState({ redis }, changed);
    res.status(204).end();
  });

  return router;
}
