// 관리자 가입 승인·반려 (SFR-083, A-01): 승인 대기 목록 · 공무원증 사진 보기(열람 기록) · 승인 · 반려.
// 사진은 승인·반려가 끝나면 바로 지우고 확인자·확인 시각만 남긴다 (DAR-012).
// 결과는 대원 개인 방(paramedic:{id})에 account.signup_result 로 보내고, 앱이 안 보이면 푸시가 간다 (dispatch.ts)
import { Router, type RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import type { PhotoStore } from '../auth/photoStore.js';
import { forgetSessionState } from '../auth/session.js';
import { appendEvents, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { adminId } from './auth.js';
import { recordAudit } from './audit.js';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().regex(/^\d+$/).optional(),
});
const idParams = z.object({ id: z.coerce.number().int().positive() });

// 반려 사유 (SFR-083). DB 에는 코드만, 기타에 쓴 내용은 작업 이력에만 남긴다
export const REJECT_REASONS = {
  photo_unclear: '사진 불명확',
  info_mismatch: '정보 불일치',
  agency_unverified: '소속 확인 불가',
  etc: '기타',
} as const;
type RejectReason = keyof typeof REJECT_REASONS;
const rejectSchema = z.object({
  // 빠지면 422 REASON_REQUIRED, 목록에 없는 값이면 400
  reason: z.enum(Object.keys(REJECT_REASONS) as [RejectReason]).optional(),
  etcText: z.string().trim().max(50).nullish(),
});

const notFound = () => new AppError(404, 'NOT_FOUND', '가입 신청을 찾을 수 없어요');
const photoDeleted = () =>
  new AppError(410, 'PHOTO_DELETED', '사진이 이미 지워졌어요 (승인·반려가 끝난 신청)');

// 파일 앞부분으로 형식을 본다 (가입 때 jpg·png 만 받는다)
const imageType = (photo: Buffer) => (photo[0] === 0x89 ? 'image/png' : 'image/jpeg');

interface SignupRow {
  id: string;
  paramedic_id: string;
  name: string;
  photo_key: string | null;
  result: string | null;
  status: string;
}

// 신청 행과 대원 행을 함께 잠근다. 두 관리자가 동시에 승인·반려를 눌러도 한 명만 처리한다
async function lockPending(client: pg.PoolClient, id: number): Promise<SignupRow> {
  const { rows } = await client.query<SignupRow>(
    `SELECT s.id, s.paramedic_id, p.name, s.photo_key, s.result, p.status
       FROM signup_request s JOIN paramedic p ON p.id = s.paramedic_id
      WHERE s.id = $1
      FOR UPDATE OF s, p`,
    [id],
  );
  const row = rows[0];
  // 탈퇴한 대원의 신청은 없는 것으로 본다
  if (!row || row.status === 'withdrawn') throw notFound();
  if (row.result !== null || row.status !== 'pending') {
    throw new AppError(409, 'ALREADY_RESPONDED', '이미 처리된 가입 신청이에요');
  }
  return row;
}

export function adminSignupRouter(
  pool: pg.Pool,
  redis: Redis,
  adminOnly: RequestHandler,
  photos: PhotoStore | undefined,
  realtime?: Pick<Realtime, 'publish'>,
): Router {
  const router = Router();

  // 승인 대기 목록: 먼저 낸 신청부터. 반려 뒤 다시 낸 신청은 표시한다
  router.get('/admin/signups', adminOnly, async (req, res) => {
    const q = parseBody(listSchema, req.query);
    const { rows } = await pool.query<{
      id: string;
      name: string;
      rank: string;
      agency_code: string;
      agency_name: string;
      safety_center: string;
      employee_no: string;
      consent_at: Date;
      created_at: Date;
      resubmitted: boolean;
    }>(
      `SELECT s.id, p.name, p.rank, a.code AS agency_code, a.name AS agency_name,
              p.safety_center, p.employee_no, s.consent_at, s.created_at,
              EXISTS (SELECT 1 FROM signup_request e
                       WHERE e.paramedic_id = s.paramedic_id AND e.id < s.id) AS resubmitted
         FROM signup_request s
         JOIN paramedic p ON p.id = s.paramedic_id
         JOIN agency a ON a.id = p.agency_id
        WHERE s.result IS NULL AND p.status = 'pending'
          AND ($1::bigint IS NULL OR s.id > $1)
        ORDER BY s.id
        LIMIT $2`,
      [q.cursor ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    res.json({
      items: page.map((s) => ({
        id: Number(s.id),
        name: s.name,
        rank: s.rank,
        agencyCode: s.agency_code,
        agencyName: s.agency_name,
        safetyCenter: s.safety_center,
        employeeNo: s.employee_no,
        consentAt: s.consent_at.toISOString(),
        createdAt: s.created_at.toISOString(),
        resubmitted: s.resubmitted,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    });
  });

  // 공무원증 사진 보기: 볼 때마다 작업 이력에 열람 1건 (SFR-083 인수 기준, SER-015).
  // 화면 캐시·프록시에 남지 않게 no-store
  router.get('/admin/signups/:id/photo', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const { rows } = await pool.query<{ photo_key: string | null; name: string; status: string }>(
      `SELECT s.photo_key, p.name, p.status
         FROM signup_request s JOIN paramedic p ON p.id = s.paramedic_id
        WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row || row.status === 'withdrawn') throw notFound();
    if (!row.photo_key) throw photoDeleted();
    if (!photos) {
      throw new AppError(503, 'PHOTO_STORAGE_UNAVAILABLE', '지금은 사진을 불러올 수 없어요');
    }
    const photo = await photos.read(row.photo_key);
    if (!photo) throw photoDeleted();

    // 사진을 실제로 내준 경우에만 열람을 남긴다
    await withTransaction(pool, (client) =>
      recordAudit(client, {
        adminId: adminId(res),
        action: 'view_signup_photo',
        targetType: 'signup_request',
        targetId: String(id),
        targetName: row.name,
      }),
    );
    res.set('Cache-Control', 'no-store');
    res.type(imageType(photo)).send(photo);
  });

  // 승인·반려 공통: 상태를 바꾸고, 사진 키를 지우고, 결과 이벤트를 남긴다 (한 트랜잭션).
  // 저장소의 사진 파일은 커밋한 '뒤에' 지운다. 먼저 지웠다가 롤백되면 '대기'인데 사진만 없는 신청이 생긴다
  async function decide(
    id: number,
    admin: string,
    result: 'approved' | 'rejected',
    reason: RejectReason | null,
    reasonText: string | null,
  ): Promise<{ paramedicId: string; photoKey: string | null; events: LoggedEvent[] }> {
    return withTransaction(pool, async (client) => {
      const s = await lockPending(client, id);
      await client.query(
        `UPDATE signup_request
            SET result = $2, reject_reason = $3, decided_by = $4, decided_at = now(), photo_key = NULL
          WHERE id = $1`,
        [s.id, result, reason, admin],
      );
      await client.query('UPDATE paramedic SET status = $2 WHERE id = $1', [
        s.paramedic_id,
        result,
      ]);
      await recordAudit(client, {
        adminId: admin,
        action: result === 'approved' ? 'approve_signup' : 'reject_signup',
        targetType: 'signup_request',
        targetId: s.id,
        targetName: s.name,
        reason: reasonText,
      });
      // 이벤트에는 결과와 사유 코드만 (절대 규칙 5). 앱은 /me 로 자세한 내용을 다시 받는다
      const events = await appendEvents(client, [
        {
          room: `paramedic:${s.paramedic_id}`,
          name: 'account.signup_result',
          entityType: 'signup_request',
          entityId: s.id,
          payload: { result, reason },
        },
      ]);
      return { paramedicId: s.paramedic_id, photoKey: s.photo_key, events };
    });
  }

  async function afterCommit(outcome: Awaited<ReturnType<typeof decide>>) {
    // 계정 상태 캐시를 지워 다음 요청부터 새 상태로 본다
    await forgetSessionState({ redis }, outcome.paramedicId);
    realtime?.publish(outcome.events);
    // 지우기에 실패해도 DB 에는 이미 키가 없어서 누구 사진인지 이어지지 않는다(키에 대원 정보 없음, photoStore.ts)
    if (outcome.photoKey && photos) await photos.remove(outcome.photoKey).catch(() => {});
  }

  router.post('/admin/signups/:id/approve', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    await afterCommit(await decide(id, adminId(res), 'approved', null, null));
    res.status(204).end();
  });

  router.post('/admin/signups/:id/reject', adminOnly, async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const input = parseBody(rejectSchema, req.body ?? {});
    if (!input.reason) throw new AppError(422, 'REASON_REQUIRED', '반려 사유를 골라 주세요');
    const reasonText =
      input.reason === 'etc' && input.etcText ? input.etcText : REJECT_REASONS[input.reason];
    await afterCommit(await decide(id, adminId(res), 'rejected', input.reason, reasonText));
    res.status(204).end();
  });

  return router;
}
