// 구급대원 가입 신청 (SFR-017) · 반려 뒤 다시 신청 (SFR-083) · 소속기관 코드 확인.
// - 공무원증 사진은 메모리로 받아 바로 암호화해 객체 저장소에 올린다 (photoStore.ts, SER-015). 원본은 디스크·로그에 남기지 않는다
// - 사진을 먼저 올리고 DB 를 쓴다. DB 가 실패하면 올린 사진을 지워 주인 없는 파일이 남지 않게 한다
// - 승인 전 계정은 로그인과 내 정보만 된다 (SFR-022, guards.ts). 승인·반려는 관리자(SFR-083)가 한다
import {
  Router,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { Redis } from 'ioredis';
import multer from 'multer';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { notifyAdmin } from '../admin/notifications.js';
import { paramedicAuth, requireParamedic } from './guards.js';
import { hashPassword } from './password.js';
import type { PhotoStore } from './photoStore.js';
import { forgetSessionState, type AuthContext } from './session.js';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
// 같은 주소에서 10분에 5번까지 (사진을 받는 공개 API라 막 보내지 못하게). 서버 2대가 같이 세도록 Redis 에 둔다 (규칙 7)
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_SECONDS = 600;

// multipart 글자 칸은 모두 문자열로 온다
const profileSchema = z.object({
  agencyCode: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(40),
  rank: z.string().trim().min(1).max(20),
  safetyCenter: z.string().trim().min(1).max(60),
  employeeNo: z.string().trim().min(1).max(30),
  photoConsent: z.enum(['true', 'false']).optional(),
});
const signupSchema = profileSchema.extend({
  loginId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9._-]{4,40}$/),
  // 길이 기준은 요구사항에 없어 8자 이상으로 정했다 (SER-004 저장은 argon2id)
  password: z.string().min(8).max(200),
});

// 메모리로만 받는다(디스크에 원본 사진을 쓰지 않음). 파일 1개·5MB 까지
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 20 },
}).single('photo');

// multer 오류(너무 큼·파일 여러 개)를 공통 오류 형식으로
const uploadErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  if (err instanceof multer.MulterError) {
    next(
      new AppError(400, 'VALIDATION_FAILED', '사진은 5MB 이하 1장이에요', { fields: ['photo'] }),
    );
    return;
  }
  next(err);
};

// 확장자·브라우저가 붙인 형식 대신 파일 앞부분으로 jpg·png 인지 본다
function isJpegOrPng(file: Buffer): boolean {
  const jpeg = file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff;
  const png = file.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return jpeg || png;
}

function parseFields<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new AppError(400, 'VALIDATION_FAILED', '입력 형식이 맞지 않아요', { fields });
  }
  return parsed.data;
}

// 사진·동의 확인 (SFR-017: 동의하지 않거나 사진이 없으면 신청할 수 없다)
function checkPhoto(file: Express.Multer.File | undefined, consent: string | undefined): Buffer {
  if (!file)
    throw new AppError(400, 'VALIDATION_FAILED', '공무원증 사진을 올려 주세요', {
      fields: ['photo'],
    });
  if (consent !== 'true') {
    throw new AppError(422, 'CONSENT_REQUIRED', '사진 수집·이용에 동의해야 신청할 수 있어요');
  }
  if (!isJpegOrPng(file.buffer)) {
    throw new AppError(400, 'VALIDATION_FAILED', '사진은 jpg·png 파일만 올릴 수 있어요', {
      fields: ['photo'],
    });
  }
  return file.buffer;
}

async function agencyId(db: Pick<pg.Pool, 'query'>, code: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM agency WHERE code = $1', [code]);
  if (!rows[0]) throw new AppError(404, 'AGENCY_NOT_FOUND', '소속기관 코드를 찾을 수 없어요');
  return rows[0].id;
}

async function underLimit(redis: Redis, ip: string): Promise<void> {
  const key = `signup:ip:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, SIGNUP_WINDOW_SECONDS);
  if (count > SIGNUP_LIMIT) {
    throw new AppError(
      429,
      'TOO_MANY_REQUESTS',
      '가입 신청이 너무 많아요. 10분 뒤에 다시 시도해 주세요',
    );
  }
}

const storageUnavailable = () =>
  new AppError(
    503,
    'PHOTO_STORAGE_UNAVAILABLE',
    '지금은 사진을 저장할 수 없어요. 잠시 후 다시 시도해 주세요',
  );

// 사진을 먼저 올리고 DB 일을 한다. DB 일이 실패하면 올린 사진을 지운다 (지우기도 실패하면 원래 오류만 알린다)
async function withUploadedPhoto<T>(
  photos: PhotoStore,
  photo: Buffer,
  work: (photoKey: string) => Promise<T>,
): Promise<T> {
  let photoKey: string;
  try {
    photoKey = await photos.save(photo);
  } catch {
    throw storageUnavailable();
  }
  try {
    return await work(photoKey);
  } catch (err) {
    await photos.remove(photoKey).catch(() => {});
    throw err;
  }
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

export function signupRouter(ctx: AuthContext, photos: PhotoStore | undefined): Router {
  const router = Router();
  const { pool, redis } = ctx;

  // 가입 화면에서 코드를 넣으면 소속기관 이름을 보여 준다 (로그인 전)
  router.get('/agencies/:code', async (req, res) => {
    const code = String(req.params.code).trim();
    const { rows } = await pool.query<{ code: string; name: string }>(
      'SELECT code, name FROM agency WHERE code = $1',
      [code],
    );
    if (!rows[0]) throw new AppError(404, 'AGENCY_NOT_FOUND', '소속기관 코드를 찾을 수 없어요');
    res.json(rows[0]);
  });

  router.post('/auth/signup', upload, uploadErrors, async (req: Request, res: Response) => {
    await underLimit(redis, req.ip ?? 'unknown');
    const input = parseFields(signupSchema, req.body);
    const photo = checkPhoto(req.file, input.photoConsent);
    const agency = await agencyId(pool, input.agencyCode);
    // 사진을 올리기 전에 먼저 본다. 겹치면 올릴 필요가 없다 (동시에 같은 아이디는 아래 유니크 오류로 한 번 더 막힘)
    const { rows: taken } = await pool.query('SELECT 1 FROM paramedic WHERE login_id = $1', [
      input.loginId,
    ]);
    if (taken[0]) throw new AppError(409, 'LOGIN_ID_TAKEN', '이미 쓰는 아이디예요');
    if (!photos) throw storageUnavailable();
    const passwordHash = await hashPassword(input.password);

    try {
      const applied = await withUploadedPhoto(photos, photo, (photoKey) =>
        withTransaction(pool, async (client) => {
          const { rows: p } = await client.query<{ id: string }>(
            `INSERT INTO paramedic (login_id, password_hash, name, rank, agency_id, safety_center, employee_no, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING id`,
            [
              input.loginId,
              passwordHash,
              input.name,
              input.rank,
              agency,
              input.safetyCenter,
              input.employeeNo,
            ],
          );
          const { rows: s } = await client.query<{ id: string; created_at: Date }>(
            `INSERT INTO signup_request (paramedic_id, photo_key, consent_at)
             VALUES ($1, $2, now()) RETURNING id, created_at`,
            [p[0].id, photoKey],
          );
          // 관리자 알림 '새 가입 신청' (SFR-100 ②)
          await notifyAdmin(client, 'signup', s[0].id);
          return s[0].created_at;
        }),
      );
      res.status(201).json({ status: 'pending', appliedAt: applied.toISOString() });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'LOGIN_ID_TAKEN', '이미 쓰는 아이디예요');
      throw err;
    }
  });

  // 반려 뒤 다시 신청: 사유를 보고 고쳐서 낸다. 같은 대원에 새 신청 행 (SFR-083)
  const meOnly: RequestHandler[] = [requireParamedic(ctx)];
  router.put('/me/signup', ...meOnly, upload, uploadErrors, async (req: Request, res: Response) => {
    const { paramedicId } = paramedicAuth(res);
    const input = parseFields(profileSchema, req.body);
    const photo = checkPhoto(req.file, input.photoConsent);
    const agency = await agencyId(pool, input.agencyCode);
    const { rows: me } = await pool.query<{ status: string }>(
      'SELECT status FROM paramedic WHERE id = $1',
      [paramedicId],
    );
    if (me[0]?.status !== 'rejected') {
      throw new AppError(409, 'SIGNUP_NOT_REJECTED', '반려된 신청만 다시 낼 수 있어요');
    }
    if (!photos) throw storageUnavailable();

    const applied = await withUploadedPhoto(photos, photo, (photoKey) =>
      withTransaction(pool, async (client) => {
        // 잠근 뒤 한 번 더 본다: 두 번 눌러도 신청은 1건
        const { rows } = await client.query<{ status: string }>(
          'SELECT status FROM paramedic WHERE id = $1 FOR UPDATE',
          [paramedicId],
        );
        if (rows[0].status !== 'rejected') {
          throw new AppError(409, 'SIGNUP_NOT_REJECTED', '반려된 신청만 다시 낼 수 있어요');
        }
        await client.query(
          `UPDATE paramedic SET name = $2, rank = $3, agency_id = $4, safety_center = $5, employee_no = $6,
                  status = 'pending'
            WHERE id = $1`,
          [paramedicId, input.name, input.rank, agency, input.safetyCenter, input.employeeNo],
        );
        const { rows: s } = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO signup_request (paramedic_id, photo_key, consent_at)
           VALUES ($1, $2, now()) RETURNING id, created_at`,
          [paramedicId, photoKey],
        );
        await notifyAdmin(client, 'signup', s[0].id);
        return s[0].created_at;
      }),
    );
    // 계정 상태 캐시를 지워 다음 요청부터 'pending'으로 본다
    await forgetSessionState(ctx, paramedicId);
    res.json({ status: 'pending', appliedAt: applied.toISOString() });
  });

  return router;
}
