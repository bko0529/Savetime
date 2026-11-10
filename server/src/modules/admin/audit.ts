// 관리자 작업 이력 (SFR-091). 병원 계정 발급·정지, 키 발급·폐기, 가입 승인 같은 작업마다 1줄씩 남긴다.
// admin_audit_log 는 DB 규칙(audit_no_update·audit_no_delete)으로 고치거나 지울 수 없다 (DAR-006)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { parseBody } from '../../http/validate.js';

// 지금 쓰는 작업 종류. 화면에 보일 이름도 같이 둔다 (뒤 스프린트에서 가입 승인·PC 해제 등이 늘어난다)
export const AUDIT_ACTIONS = {
  issue_account: '병원 계정 발급',
  suspend_hospital: '병원 계정 정지',
  revoke_key: '라이선스 키 폐기',
  reissue_key: '라이선스 키 재발급',
  release_pc: '병원 PC 해제',
  suspend_paramedic: '대원 계정 정지',
  unsuspend_paramedic: '대원 계정 정지 해제',
  view_signup_photo: '공무원증 사진 열람',
  approve_signup: '가입 승인',
  reject_signup: '가입 반려',
  set_entrance: '응급실 입구 좌표 지정',
  reset_password: '대원 비밀번호 초기화',
  enable_feature: '기능 켜기',
  disable_feature: '기능 끄기',
} as const;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

export interface AuditEntry {
  adminId: string;
  action: AuditAction;
  targetType: 'hospital' | 'hospital_pc' | 'paramedic' | 'signup_request' | 'feature_flag';
  // 기능 토글처럼 숫자 id 가 없는 대상은 null (이름은 targetName 에)
  targetId: string | null;
  // 대상 이름(나중에 이름이 바뀌어도 그때 이름이 남게)·사유. 키 같은 비밀 값은 넣지 않는다
  targetName: string;
  reason?: string | null;
}

// 작업과 같은 트랜잭션 안에서 부른다. 작업이 롤백되면 이력도 남지 않고, 이력이 실패하면 작업도 취소된다
export async function recordAudit(client: pg.PoolClient, e: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      e.adminId,
      e.action,
      e.targetType,
      e.targetId,
      { targetName: e.targetName, reason: e.reason ?? null },
    ],
  );
}

const listSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // 최신순이라 '이 id 보다 작은 것'부터 이어 받는다 (id 는 넣은 순서대로 커진다)
  cursor: z.string().regex(/^\d+$/).optional(),
});

interface AuditRow {
  id: string;
  created_at: Date;
  admin_name: string;
  action: string;
  detail: { targetName?: string; reason?: string | null } | null;
}

// GET /admin/audit-logs (A-02 모니터링)
export function auditRouter(pool: pg.Pool, adminOnly: RequestHandler): Router {
  const router = Router();
  router.get('/admin/audit-logs', adminOnly, async (req, res) => {
    const q = parseBody(listSchema, req.query);
    const { rows } = await pool.query<AuditRow>(
      `SELECT l.id, l.created_at, a.name AS admin_name, l.action, l.detail
         FROM admin_audit_log l JOIN admin a ON a.id = l.admin_id
        WHERE ($1::timestamptz IS NULL OR l.created_at >= $1)
          AND ($2::timestamptz IS NULL OR l.created_at < $2)
          AND ($3::bigint IS NULL OR l.id < $3)
        ORDER BY l.id DESC
        LIMIT $4`,
      [q.from ?? null, q.to ?? null, q.cursor ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    res.json({
      items: page.map((r) => ({
        at: r.created_at.toISOString(),
        admin: r.admin_name,
        action: AUDIT_ACTIONS[r.action as AuditAction] ?? r.action,
        target: r.detail?.targetName ?? '',
        reason: r.detail?.reason ?? null,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    });
  });
  return router;
}
