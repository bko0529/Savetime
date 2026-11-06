// 관리자 병원 등록 PC 관리 (SFR-147, A-03): 병원별 등록 PC 목록 · 해제 · 90일 안 쓴 PC 자동 해제.
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { UNUSED_DAYS } from '../hospital-web/pcAuth.js';
import type { Realtime } from '../realtime/server.js';
import { adminId } from './auth.js';
import { recordAudit } from './audit.js';
import { notifyAdmin } from './notifications.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
export const HOUSEKEEPING_EVERY_MS = 60 * 60 * 1000;

// 해제한 PC 에서 알림 켠 근무를 끈다. 이 병원이 다른 PC 로만 요청을 받게 된다
async function stopShifts(client: pg.PoolClient, pcIds: string[]): Promise<void> {
  await client.query(
    'UPDATE hospital_shift SET alarm_on_at = NULL WHERE ended_at IS NULL AND pc_id = ANY($1::bigint[])',
    [pcIds],
  );
}

export function adminPcRouter(
  pool: pg.Pool,
  adminOnly: RequestHandler,
  realtime?: Pick<Realtime, 'revokePc' | 'onlinePcIds'>,
): Router {
  const router = Router();

  // 등록 PC 목록: 지금 쓰는 PC 만, 최근에 쓴 순서로
  router.get('/admin/hospitals/:id/pcs', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const { rows: hospitals } = await pool.query('SELECT 1 FROM hospital WHERE id = $1', [id]);
    if (!hospitals[0]) throw new AppError(404, 'NOT_FOUND', '병원을 찾을 수 없어요');

    const { rows } = await pool.query<{
      id: string;
      name: string;
      registered_at: Date;
      last_used_at: Date;
    }>(
      `SELECT id, name, registered_at, last_used_at FROM hospital_pc
        WHERE hospital_id = $1 AND released_at IS NULL
        ORDER BY last_used_at DESC`,
      [id],
    );
    // 접속 중인지는 실시간 서버에 묻는다 (서버 2대여도 Redis 어댑터가 모아 준다). 없으면 모두 false
    const online = new Set(realtime ? await realtime.onlinePcIds(String(id)) : []);
    res.json(
      rows.map((pc) => ({
        id: Number(pc.id),
        name: pc.name,
        registeredAt: pc.registered_at.toISOString(),
        lastUsedAt: pc.last_used_at.toISOString(),
        online: online.has(pc.id),
      })),
    );
  });

  // PC 해제: 그 PC 에서 병원 웹이 바로 막힌다. 작업 이력·관리자 알림에 남긴다
  router.delete('/admin/pcs/:id', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const released = await withTransaction(pool, async (client) => {
      // 병원 행을 잠근다 (PC 등록·키 재발급과 같은 잠금이라 자리 계산이 엇갈리지 않는다)
      const { rows } = await client.query<{ hospital_id: string; hospital_name: string }>(
        `SELECT h.id AS hospital_id, h.name AS hospital_name
           FROM hospital h JOIN hospital_pc pc ON pc.hospital_id = h.id
          WHERE pc.id = $1 FOR UPDATE OF h`,
        [id],
      );
      const hospital = rows[0];
      if (!hospital) throw new AppError(404, 'NOT_FOUND', 'PC를 찾을 수 없어요');
      // 잠금을 얻은 다음 문장에서 해제한다. 이미 풀린 PC 면 아무것도 바꾸지 않는다
      const { rows: pcs } = await client.query<{ name: string }>(
        `UPDATE hospital_pc SET released_at = now()
          WHERE id = $1 AND released_at IS NULL RETURNING name`,
        [id],
      );
      if (!pcs[0]) return null;

      await stopShifts(client, [String(id)]);
      await recordAudit(client, {
        adminId: adminId(res),
        action: 'release_pc',
        targetType: 'hospital_pc',
        targetId: String(id),
        targetName: `${hospital.hospital_name} · ${pcs[0].name}`,
      });
      await notifyAdmin(client, 'pc_change', hospital.hospital_id);
      return { pcId: String(id), hospitalId: hospital.hospital_id };
    });
    // 커밋 뒤 그 PC 탭만 끊는다. 다시 붙으면 인증에서 PC_NOT_REGISTERED 로 막힌다
    if (released) await realtime?.revokePc(released, 'pc_released');
    res.status(204).end();
  });

  return router;
}

// 90일 동안 안 쓴 PC 등록 자동 해제 (SFR-147). 주기 작업이 부른다.
// 지금까지는 그 PC 가 다시 접속하거나 같은 병원이 새 PC 를 등록할 때만 풀렸다.
// 이제는 접속이 없어도 정해진 때에 풀리고, 병원마다 관리자 알림을 남긴다. 판정은 DB now() (규칙 6)
export async function releaseUnusedPcs(pool: pg.Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; hospital_id: string }>(
      `UPDATE hospital_pc SET released_at = now()
        WHERE released_at IS NULL AND last_used_at < now() - make_interval(days => $1)
        RETURNING id, hospital_id`,
      [UNUSED_DAYS],
    );
    if (rows.length === 0) return 0;
    await stopShifts(
      client,
      rows.map((r) => r.id),
    );
    for (const hospitalId of new Set(rows.map((r) => r.hospital_id))) {
      await notifyAdmin(client, 'pc_change', hospitalId);
    }
    return rows.length;
  });
}
