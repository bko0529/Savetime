// 병원 웹: PC 등록·현재 PC 정보 (SFR-116, SFR-147, SER-011, COR-012)
import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { notifyAdmin } from '../admin/notifications.js';
import { hashLicenseKey } from './licenseKey.js';
import {
  checkOrigin,
  hashPcToken,
  hospitalPc,
  newPcToken,
  requireHospitalPc,
  setPcCookie,
  UNUSED_DAYS,
  type HospitalWebContext,
} from './pcAuth.js';

export const MAX_PCS = 3;
// 키 입력 5번 연속 실패 → 그 PC(접속 주소)에서 10분 막음 (SER-011)
export const MAX_KEY_FAILURES = 5;
export const KEY_LOCK_SECONDS = 600;

const registerSchema = z.object({
  licenseKey: z.string().min(1).max(60),
  pcName: z.string().trim().min(1).max(40),
  replacePcId: z.number().int().positive().nullish(),
});

interface PcSummary {
  id: number;
  name: string;
  lastUsedAt: string;
}

type RegisterOutcome =
  | { kind: 'ok'; hospital: { id: number; name: string }; pcId: number; token: string }
  | { kind: 'full'; pcs: PcSummary[] }
  | { kind: 'bad_replace' };

// 실패 횟수는 서버 메모리가 아니라 Redis 에 센다. 서버가 2대가 돼도 같이 센다 (규칙 7)
const failKey = (ip: string) => `hw:license-fail:${ip}`;

export function hospitalWebRouter(ctx: HospitalWebContext): Router {
  const router = Router();
  const pcOnly = requireHospitalPc(ctx);
  router.use('/hw', checkOrigin(ctx.allowedOrigins));

  router.post('/hw/pc/register', async (req, res) => {
    const input = parseBody(registerSchema, req.body);
    const ip = req.ip ?? 'unknown';

    const [failures, ttl] = await Promise.all([
      ctx.redis.get(failKey(ip)),
      ctx.redis.ttl(failKey(ip)),
    ]);
    if (Number(failures ?? 0) >= MAX_KEY_FAILURES) {
      throw new AppError(423, 'TOO_MANY_ATTEMPTS', '키를 여러 번 틀려 잠시 막았어요', {
        retryAfterSeconds: Math.max(ttl, 1),
      });
    }

    const { rows: keys } = await ctx.pool.query<{
      hospital_id: string;
      revoked: boolean;
      expired: boolean;
    }>(
      `SELECT hospital_id, revoked_at IS NOT NULL AS revoked, expires_at <= now() AS expired
         FROM license_key WHERE key_hash = $1`,
      [hashLicenseKey(input.licenseKey)],
    );
    const key = keys[0];
    // 없는 키·폐기된 키는 같은 답을 준다. 어떤 키가 한때 있었는지 알려 줄 필요가 없다
    if (!key || key.revoked) {
      await ctx.redis.multi().incr(failKey(ip)).expire(failKey(ip), KEY_LOCK_SECONDS).exec();
      throw new AppError(401, 'INVALID_LICENSE', '라이선스 키가 맞지 않아요');
    }
    // 맞는 키지만 기간이 끝남: 틀린 입력이 아니라서 실패로 세지 않는다
    if (key.expired) throw new AppError(403, 'LICENSE_EXPIRED', '라이선스 키 기간이 끝났어요');
    await ctx.redis.del(failKey(ip));

    // 같은 병원 PC 등록을 한 줄로 세운다 (병원 행 FOR UPDATE).
    // 두 PC 가 동시에 4번째 자리를 차지해 3대를 넘는 일을 막는다
    const outcome = await withTransaction(ctx.pool, async (client): Promise<RegisterOutcome> => {
      const { rows: hospitals } = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM hospital WHERE id = $1 FOR UPDATE',
        [key.hospital_id],
      );
      const hospital = hospitals[0];

      // 오래 안 쓴 PC 는 자리를 비운다 (SFR-147)
      await client.query(
        `UPDATE hospital_pc SET released_at = now()
          WHERE hospital_id = $1 AND released_at IS NULL
            AND last_used_at < now() - make_interval(days => $2)`,
        [hospital.id, UNUSED_DAYS],
      );

      if (input.replacePcId) {
        const { rowCount } = await client.query(
          `UPDATE hospital_pc SET released_at = now()
            WHERE id = $1 AND hospital_id = $2 AND released_at IS NULL`,
          [input.replacePcId, hospital.id],
        );
        if (rowCount === 0) return { kind: 'bad_replace' };
      }

      const { rows: active } = await client.query<{
        id: string;
        name: string;
        last_used_at: Date;
      }>(
        `SELECT id, name, last_used_at FROM hospital_pc
          WHERE hospital_id = $1 AND released_at IS NULL ORDER BY last_used_at DESC`,
        [hospital.id],
      );
      if (active.length >= MAX_PCS) {
        return {
          kind: 'full',
          pcs: active.map((pc) => ({
            id: Number(pc.id),
            name: pc.name,
            lastUsedAt: pc.last_used_at.toISOString(),
          })),
        };
      }

      const token = newPcToken();
      const { rows: inserted } = await client.query<{ id: string }>(
        'INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id',
        [hospital.id, input.pcName, hashPcToken(token)],
      );
      // PC 가 바뀌면 관리자가 알 수 있게 한다 (모르는 PC 등록 감시)
      await notifyAdmin(client, 'pc_change', hospital.id);
      return {
        kind: 'ok',
        hospital: { id: Number(hospital.id), name: hospital.name },
        pcId: Number(inserted[0].id),
        token,
      };
    });

    if (outcome.kind === 'full') {
      throw new AppError(409, 'PC_LIMIT_REACHED', 'PC 3대가 모두 등록돼 있어요', {
        pcs: outcome.pcs,
      });
    }
    if (outcome.kind === 'bad_replace') {
      throw new AppError(400, 'VALIDATION_FAILED', '바꿀 PC를 찾을 수 없어요', {
        fields: ['replacePcId'],
      });
    }

    setPcCookie(res, outcome.token);
    res.status(201).json({ hospital: outcome.hospital, pcId: outcome.pcId });
  });

  router.get('/hw/session', pcOnly, async (_req, res) => {
    const pc = hospitalPc(res);
    const { rows } = await ctx.pool.query<{
      shift_id: string | null;
      staff_name: string | null;
      alarm_on: boolean | null;
      paused: boolean;
      paused_at: Date | null;
      server_now: Date;
    }>(
      `SELECT s.id AS shift_id, s.staff_name, s.alarm_on_at IS NOT NULL AS alarm_on,
              h.requests_paused AS paused, h.paused_at, now() AS server_now
         FROM hospital h
         LEFT JOIN LATERAL (
           SELECT id, staff_name, alarm_on_at FROM hospital_shift
            WHERE pc_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1
         ) s ON true
        WHERE h.id = $1`,
      [pc.hospitalId, pc.pcId],
    );
    const row = rows[0];
    res.json({
      hospital: { id: pc.hospitalId, name: pc.hospitalName },
      pc: { id: pc.pcId, name: pc.pcName },
      licenseDaysLeft: pc.licenseDaysLeft,
      shift: row.shift_id
        ? { id: Number(row.shift_id), staffName: row.staff_name, alarmOn: row.alarm_on }
        : null,
      paused: row.paused,
      pausedAt: row.paused_at?.toISOString() ?? null,
      serverNow: row.server_now.toISOString(),
    });
  });

  return router;
}
