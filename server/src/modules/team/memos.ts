// 나만 보는 한 줄 메모 (SFR-143, S-03): 대원이 다른 대원에 대해 남기는 메모. 쓴 사람만 본다.
// 팀원 목록 초대(GET /paramedics/on-duty, invites.ts)가 '내가 쓴 메모'만 붙여서 보여 준다.
// 메모 글은 이벤트·로그에 넣지 않는다
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';

const paramsSchema = z.object({ paramedicId: z.coerce.number().int().positive() });
// 20자까지. 빈 글(공백만 포함)이면 메모를 지운다
const bodySchema = z.object({ memo: z.string().trim().max(20) });

export function memoRouter(pool: pg.Pool, guards: RequestHandler[]): Router {
  const router = Router();

  router.put('/memos/:paramedicId', ...guards, async (req, res) => {
    const { paramedicId: targetId } = parseBody(paramsSchema, req.params);
    const { memo } = parseBody(bodySchema, req.body);
    const ownerId = paramedicAuth(res).paramedicId;

    // 메모를 달 수 있는 대원 = 팀원 목록에 나올 수 있는 대원 (같은 소방서 · 승인된 계정 · 내가 아님).
    // 그 밖은 있는지조차 알리지 않고 404 (SER-010)
    const { rows } = await pool.query(
      `SELECT 1 FROM paramedic p JOIN paramedic me ON me.id = $1
        WHERE p.id = $2 AND p.id <> me.id AND p.agency_id = me.agency_id AND p.status = 'approved'`,
      [ownerId, targetId],
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', '대원을 찾을 수 없어요');

    if (memo === '') {
      await pool.query('DELETE FROM paramedic_memo WHERE owner_id = $1 AND target_id = $2', [
        ownerId,
        targetId,
      ]);
    } else {
      // 같은 대원에게 다시 쓰면 덮어쓴다 (대원마다 메모 1개)
      await pool.query(
        `INSERT INTO paramedic_memo (owner_id, target_id, memo) VALUES ($1, $2, $3)
         ON CONFLICT (owner_id, target_id) DO UPDATE SET memo = excluded.memo`,
        [ownerId, targetId, memo],
      );
    }
    res.status(204).end();
  });

  return router;
}
