// 관리자 병원 관리 (SFR-123, SFR-146, A-03): 공공 데이터 병원 검색 → 병원 계정·라이선스 키 발급 → 정지 · 키 폐기·재발급.
// 키 전체는 발급 응답에서 한 번만 보여 주고 DB 에는 해시·앞 4자리만 둔다 (COR-013)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { isInKorea } from '../../domain/geo.js';
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
// 응급실 입구 좌표 (SFR-145). 지도에서 찍은 값. 소수점 6자리(약 10cm)까지만 저장한다 (DB numeric(9,6))
const entranceSchema = z.object({
  lat: z.number().finite(),
  lng: z.number().finite(),
});
// 폐기·재발급 사유 (SFR-146). 비어 있으면 422 REASON_REQUIRED, 60자 넘으면 400
const reasonSchema = z.object({ reason: z.string().trim().max(60).optional() });

function requireReason(body: unknown): string {
  const { reason } = parseBody(reasonSchema, body ?? {});
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', '사유를 입력해 주세요');
  return reason;
}

// 병원의 살아 있는 키를 모두 폐기하고, 그 병원 PC 등록을 모두 해제한다 (SFR-146).
// 병원마다 쓰는 키는 하나라서 '그 키로 등록한 PC' = '그 병원의 등록 PC' 다.
// 해제된 PC 는 다음 요청에서 PC_NOT_REGISTERED 로 막히고, 병원 웹은 키 입력 화면으로 돌아간다
async function invalidateHospitalKeys(
  client: pg.PoolClient,
  hospitalId: string,
  reason: string,
  onlyKeyId?: string,
): Promise<void> {
  await client.query(
    `UPDATE license_key SET revoked_at = now(), revoke_reason = $2
      WHERE hospital_id = $1 AND revoked_at IS NULL AND ($3::bigint IS NULL OR id = $3)`,
    [hospitalId, reason, onlyKeyId ?? null],
  );
  await client.query(
    'UPDATE hospital_pc SET released_at = now() WHERE hospital_id = $1 AND released_at IS NULL',
    [hospitalId],
  );
  // 알림 켠 근무도 꺼서 이 병원이 새 요청 대상에서 바로 빠지게 한다 (정지와 같은 처리)
  await client.query(
    `UPDATE hospital_shift SET alarm_on_at = NULL
      WHERE ended_at IS NULL
        AND pc_id IN (SELECT id FROM hospital_pc WHERE hospital_id = $1)`,
    [hospitalId],
  );
}

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
  lat: number | null;
  lng: number | null;
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
              h.lat::float8 AS lat, h.lng::float8 AS lng,
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
        // 공공 데이터 병원 좌표. 입구를 저장하지 않으면 도착 판정은 이 좌표로 한다.
        // 관리자 화면이 입구를 찍을 지도의 처음 가운데로도 쓴다 (SFR-145)
        location:
          h.lat !== null && h.lng !== null && isInKorea(h.lat, h.lng)
            ? { lat: h.lat, lng: h.lng }
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

  // 키 재발급 (SFR-146): 이전 키 폐기 + PC 등록 전부 해제 + 새 키 발급을 한 트랜잭션으로.
  // 중간에 실패하면 전부 되돌아가서 '옛 키는 죽었는데 새 키는 없는' 상태가 생기지 않는다
  router.post('/admin/hospitals/:id/license-keys', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const reason = requireReason(req.body);
    const key = newLicenseKey();
    const issued = await withTransaction(pool, async (client) => {
      // 병원 행을 잠가서 재발급·폐기·계정 발급이 같은 병원에 동시에 일어나지 않게 한다
      const { rows } = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM hospital WHERE id = $1 FOR UPDATE',
        [id],
      );
      const hospital = rows[0];
      if (!hospital) throw notFound();
      // 계정 발급 전 병원은 재발급이 아니라 계정 발급(SFR-123)을 써야 한다
      const { rows: keysBefore } = await client.query(
        'SELECT 1 FROM license_key WHERE hospital_id = $1 LIMIT 1',
        [id],
      );
      if (keysBefore.length === 0) {
        throw new AppError(404, 'NOT_FOUND', '발급한 키가 없어요. 먼저 병원 계정을 발급해 주세요');
      }

      await invalidateHospitalKeys(client, hospital.id, reason);
      const { rows: keys } = await client.query<{ expires_at: Date }>(
        `INSERT INTO license_key (hospital_id, key_hash, key_prefix, issued_by, expires_at)
         VALUES ($1, $2, $3, $4, now() + $5::interval) RETURNING expires_at`,
        [id, hashLicenseKey(key), licenseKeyPrefix(key), adminId(res), KEY_VALID_INTERVAL],
      );
      await recordAudit(client, {
        adminId: adminId(res),
        action: 'reissue_key',
        targetType: 'hospital',
        targetId: hospital.id,
        targetName: hospital.name,
        reason,
      });
      return { expiresAt: keys[0].expires_at };
    });

    // 열려 있는 병원 웹 탭은 커밋 뒤 바로 끊는다 (인수 기준 '3대 모두 막힘')
    await realtime?.revokeHospital(String(id), 'key_revoked');
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ licenseKey: key, expiresAt: issued.expiresAt.toISOString() });
  });

  // 키 폐기 (SFR-146): 키와 그 병원 PC 등록을 즉시 무효로. 새 키는 만들지 않는다
  router.post('/admin/license-keys/:id/revoke', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const reason = requireReason(req.body);
    const revoked = await withTransaction(pool, async (client) => {
      // 키의 병원 행을 잠근다 (재발급과 같은 잠금 순서라 서로 엇갈려 멈추지 않는다)
      const { rows } = await client.query<{ id: string; name: string }>(
        `SELECT h.id, h.name FROM hospital h JOIN license_key lk ON lk.hospital_id = h.id
          WHERE lk.id = $1 FOR UPDATE OF h`,
        [id],
      );
      const hospital = rows[0];
      if (!hospital) throw new AppError(404, 'NOT_FOUND', '키를 찾을 수 없어요');
      // 폐기됐는지는 잠금을 얻은 다음 문장에서 본다 (먼저 끝난 관리자의 폐기를 보기 위해)
      const { rows: keys } = await client.query<{ revoked: boolean }>(
        'SELECT revoked_at IS NOT NULL AS revoked FROM license_key WHERE id = $1',
        [id],
      );
      // 이미 폐기된 키면 아무것도 바꾸지 않고 이력도 두 번 남기지 않는다
      if (keys[0].revoked) return null;

      await invalidateHospitalKeys(client, hospital.id, reason, String(id));
      await recordAudit(client, {
        adminId: adminId(res),
        action: 'revoke_key',
        targetType: 'hospital',
        targetId: hospital.id,
        targetName: hospital.name,
        reason,
      });
      return hospital.id;
    });
    if (revoked) await realtime?.revokeHospital(revoked, 'key_revoked');
    res.status(204).end();
  });

  // 응급실 입구 좌표 지정 (SFR-145). 저장하면 이 병원의 도착 판정·목적지 좌표가 이 좌표로 바뀐다
  // (앱 목적지 view.ts, 병원 웹 도착 확인 200m confirmArrival.ts 가 모두 entrance_lat/lng 을 먼저 본다)
  router.put('/admin/hospitals/:id/entrance', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const input = parseBody(entranceSchema, req.body);
    // 지도에서 잘못 찍은 바다 한가운데 같은 값은 받지 않는다
    if (!isInKorea(input.lat, input.lng)) {
      throw new AppError(400, 'VALIDATION_FAILED', '좌표 범위 오류: 대한민국 밖 좌표예요', {
        fields: ['lat', 'lng'],
        reason: 'coords_out_of_korea',
      });
    }
    await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM hospital WHERE id = $1 FOR UPDATE',
        [id],
      );
      const hospital = rows[0];
      if (!hospital) throw notFound();
      await client.query('UPDATE hospital SET entrance_lat = $2, entrance_lng = $3 WHERE id = $1', [
        id,
        input.lat,
        input.lng,
      ]);
      // 좌표 값은 이력에 넣지 않는다 (병원 이름만). 지금 좌표는 병원 목록에서 본다
      await recordAudit(client, {
        adminId: adminId(res),
        action: 'set_entrance',
        targetType: 'hospital',
        targetId: hospital.id,
        targetName: hospital.name,
      });
    });
    res.status(204).end();
  });

  return router;
}
