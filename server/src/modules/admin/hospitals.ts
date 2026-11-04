// 관리자 병원 관리 (SFR-123, A-03): 공공 데이터 병원 검색 → 병원 계정·라이선스 키 발급 → 정지.
// 키 전체는 발급 응답에서 한 번만 보여 주고 DB 에는 해시·앞 4자리만 둔다 (COR-013)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { hashLicenseKey, licenseKeyPrefix, newLicenseKey } from '../hospital-web/licenseKey.js';
import { MAX_PCS } from '../hospital-web/routes.js';
import type { Realtime } from '../realtime/server.js';
import { adminId } from './auth.js';
import { recordAudit } from './audit.js';

// 키 유효기간 1년 (SFR-123)
const KEY_VALID_INTERVAL = '1 year';

const searchSchema = z.object({
  q: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().regex(/^\d+$/).optional(),
});
const idParams = z.object({ id: z.coerce.number().int().positive() });

interface HospitalRow {
  id: string;
  name: string;
  account_active: boolean;
  pc_count: number;
  key_id: string | null;
  key_prefix: string | null;
  key_expires_at: Date | null;
  key_days_left: number | null;
  entrance_lat: string | null;
  entrance_lng: string | null;
}

// LIKE 의 % · _ 를 글자 그대로 찾게 한다 (병원 이름에 들어 있어도 검색이 이상해지지 않게)
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const notFound = () => new AppError(404, 'NOT_FOUND', '병원을 찾을 수 없어요');

export function adminHospitalRouter(
  pool: pg.Pool,
  adminOnly: RequestHandler,
  realtime?: Realtime,
): Router {
  const router = Router();

  // 병원 검색: 이름 일부로 찾는다. 계정 상태·등록 PC 수·지금 쓰는 키(앞 4자리)를 같이 보여 준다
  router.get('/admin/hospitals', adminOnly, async (req, res) => {
    const q = parseBody(searchSchema, req.query);
    const { rows } = await pool.query<HospitalRow>(
      `SELECT h.id, h.name, h.account_active, h.entrance_lat, h.entrance_lng,
              (SELECT count(*)::int FROM hospital_pc p
                WHERE p.hospital_id = h.id AND p.released_at IS NULL) AS pc_count,
              k.id AS key_id, k.key_prefix, k.expires_at AS key_expires_at,
              ceil(extract(epoch FROM k.expires_at - now()) / 86400)::int AS key_days_left
         FROM hospital h
         LEFT JOIN LATERAL (
           SELECT id, key_prefix, expires_at FROM license_key
            WHERE hospital_id = h.id AND revoked_at IS NULL
            ORDER BY issued_at DESC LIMIT 1
         ) k ON true
        WHERE ($1::text IS NULL OR h.name ILIKE '%' || $1 || '%')
          AND ($2::bigint IS NULL OR h.id > $2)
        ORDER BY h.id
        LIMIT $3`,
      [q.q ? likeEscape(q.q) : null, q.cursor ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    res.json({
      items: page.map((h) => ({
        id: Number(h.id),
        name: h.name,
        accountActive: h.account_active,
        pcCount: h.pc_count,
        pcLimit: MAX_PCS,
        license: h.key_id
          ? {
              id: Number(h.key_id),
              prefix: h.key_prefix,
              expiresAt: h.key_expires_at!.toISOString(),
              daysLeft: Math.max(0, h.key_days_left ?? 0),
            }
          : null,
        entrance:
          h.entrance_lat && h.entrance_lng
            ? { lat: Number(h.entrance_lat), lng: Number(h.entrance_lng) }
            : null,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    });
  });

  // 병원 계정 + 라이선스 키 발급. 병원 행을 잠가서 두 관리자가 동시에 눌러도 한 번만 발급된다
  router.post('/admin/hospitals/:id/account', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const key = newLicenseKey();
    const issued = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM hospital WHERE id = $1 FOR UPDATE',
        [id],
      );
      const hospital = rows[0];
      if (!hospital) throw notFound();
      // 키가 있는지는 잠금을 얻은 '다음' 문장에서 따로 본다. 잠금을 기다린 문장 안의 하위 질의는
      // 기다리기 전 시점의 데이터를 봐서, 먼저 끝난 관리자가 만든 키를 못 보고 두 번 발급한다
      const { rows: keysBefore } = await client.query(
        'SELECT 1 FROM license_key WHERE hospital_id = $1 LIMIT 1',
        [id],
      );
      // 한 번이라도 발급한 병원(정지된 병원 포함)은 새로 발급하지 않는다. 키 재발급은 SFR-146
      if (keysBefore.length > 0) {
        throw new AppError(409, 'ACCOUNT_EXISTS', '이미 병원 계정이 있어요');
      }

      const { rows: keys } = await client.query<{ expires_at: Date }>(
        `INSERT INTO license_key (hospital_id, key_hash, key_prefix, issued_by, expires_at)
         VALUES ($1, $2, $3, $4, now() + $5::interval) RETURNING expires_at`,
        [id, hashLicenseKey(key), licenseKeyPrefix(key), adminId(res), KEY_VALID_INTERVAL],
      );
      await client.query('UPDATE hospital SET account_active = true WHERE id = $1', [id]);
      await recordAudit(client, {
        adminId: adminId(res),
        action: 'issue_account',
        targetType: 'hospital',
        targetId: hospital.id,
        targetName: hospital.name,
      });
      return { expiresAt: keys[0].expires_at };
    });

    // 키 전체가 담긴 응답은 브라우저·프록시가 저장하지 않게 한다
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ licenseKey: key, expiresAt: issued.expiresAt.toISOString() });
  });

  // 병원 계정 정지: 그 병원의 모든 등록 PC 가 다음 요청부터 막힌다 (requireHospitalPc 가 요청마다 확인)
  router.post('/admin/hospitals/:id/suspend', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const suspended = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string; name: string; account_active: boolean }>(
        'SELECT id, name, account_active FROM hospital WHERE id = $1 FOR UPDATE',
        [id],
      );
      const hospital = rows[0];
      if (!hospital) throw notFound();
      // 이미 정지돼 있으면 아무것도 바꾸지 않고, 이력도 두 번 남기지 않는다
      if (!hospital.account_active) return false;

      await client.query('UPDATE hospital SET account_active = false WHERE id = $1', [id]);
      // 알림 켠 근무를 꺼서 이 병원이 새 요청 대상에서 바로 빠지게 한다
      await client.query(
        `UPDATE hospital_shift SET alarm_on_at = NULL
          WHERE ended_at IS NULL
            AND pc_id IN (SELECT id FROM hospital_pc WHERE hospital_id = $1)`,
        [id],
      );
      await recordAudit(client, {
        adminId: adminId(res),
        action: 'suspend_hospital',
        targetType: 'hospital',
        targetId: hospital.id,
        targetName: hospital.name,
      });
      return true;
    });
    // 이미 열려 있는 병원 웹 탭도 커밋 뒤 바로 막는다 (SFR-123 인수 기준 '두 PC 모두 막힘')
    if (suspended) await realtime?.revokeHospital(String(id), 'account_suspended');
    res.status(204).end();
  });

  return router;
}
