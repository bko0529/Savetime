// 관리자 로그인 (비밀번호 + OTP)·첫 OTP 연결 (SFR-082, SFR-152). 관리자 가입은 없고 초기 데이터로만 만든다 (COR-007)
import { createHash, randomBytes } from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { verifyPassword } from '../auth/password.js';
import { hashRefreshToken, newRefreshToken } from '../auth/tokens.js';
import { checkOrigin } from '../hospital-web/pcAuth.js';
import { newOtpSecret, otpauthUrl, verifyOtp } from './otp.js';
import { signAdminAccessToken, verifyAdminAccessToken } from './tokens.js';

export interface AdminContext {
  pool: pg.Pool;
  redis: Redis;
  jwtKey: Uint8Array;
  // 갱신 토큰을 쓸 수 있는 시간 (대원 근무 시간과 같은 값)
  sessionHours: number;
  allowedOrigins: string[];
}

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 10;
// 첫 OTP 연결은 5분 안에 끝내야 한다
export const SETUP_SECONDS = 300;
const MAX_SETUP_TRIES = 5;

const otpCode = z.string().regex(/^\d{6}$/);
const loginSchema = z.object({
  loginId: z.string().min(1).max(40),
  password: z.string().min(1).max(200),
  otp: otpCode.optional(),
});
const enrollSchema = z.object({ setupToken: z.string().min(1).max(100), otp: otpCode });

interface AdminRow {
  id: string;
  login_id: string;
  password_hash: string;
  otp_secret: string | null;
  enrolled: boolean;
  lock_seconds: number | null;
}

type LoginOutcome =
  | { kind: 'ok'; adminId: string }
  | { kind: 'invalid_credentials' }
  | { kind: 'invalid_otp' }
  | { kind: 'locked'; seconds: number }
  | { kind: 'setup'; adminId: string; loginId: string };

interface SetupState {
  adminId: string;
  loginId: string;
  secret: string;
}

// 연결용 토큰도 Redis 에는 해시로만 둔다
const setupKey = (token: string) =>
  `admin:otp-setup:${createHash('sha256').update(token).digest('hex')}`;

function locked(seconds: number): AppError {
  return new AppError(423, 'ACCOUNT_LOCKED', '로그인을 잠시 막았어요', {
    retryAfterSeconds: seconds,
  });
}

// 틀린 비밀번호·OTP 를 센다. 5번째면 0으로 돌리고 10분 잠근다. 잠갔으면 남은 초를 돌려준다
async function recordFailure(client: pg.PoolClient, adminId: string): Promise<number | null> {
  const { rows } = await client.query<{ lock_seconds: number | null }>(
    `UPDATE admin
        SET failed_count = CASE WHEN failed_count + 1 >= $2 THEN 0 ELSE failed_count + 1 END,
            locked_until = CASE WHEN failed_count + 1 >= $2
                                THEN now() + make_interval(mins => $3) END
      WHERE id = $1
     RETURNING CASE WHEN locked_until IS NOT NULL
                    THEN ceil(extract(epoch FROM locked_until - now()))::int END AS lock_seconds`,
    [adminId, MAX_FAILURES, LOCK_MINUTES],
  );
  return rows[0].lock_seconds;
}

async function issueTokens(ctx: AdminContext, adminId: string) {
  const refreshToken = newRefreshToken();
  await ctx.pool.query(
    `INSERT INTO refresh_token (owner_type, owner_id, token_hash, expires_at)
     VALUES ('admin', $1, $2, now() + make_interval(hours => $3))`,
    [adminId, hashRefreshToken(refreshToken), ctx.sessionHours],
  );
  return { accessToken: await signAdminAccessToken(ctx.jwtKey, adminId), refreshToken };
}

export function adminAuthRouter(ctx: AdminContext): Router {
  const router = Router();
  router.use('/admin', checkOrigin(ctx.allowedOrigins));

  router.post('/admin/auth/login', async (req, res) => {
    const input = parseBody(loginSchema, req.body);

    // 같은 계정의 시도를 한 줄로 세운다 (FOR UPDATE). 실패 횟수를 저장해야 해서
    // 오류는 트랜잭션 안에서 던지지 않고 결과만 돌려준 뒤 밖에서 던진다 (안에서 던지면 롤백돼 잠금이 안 걸림)
    const outcome = await withTransaction(ctx.pool, async (client): Promise<LoginOutcome> => {
      const { rows } = await client.query<AdminRow>(
        `SELECT id, login_id, password_hash, otp_secret, otp_enrolled_at IS NOT NULL AS enrolled,
                CASE WHEN locked_until > now()
                     THEN ceil(extract(epoch FROM locked_until - now()))::int END AS lock_seconds
           FROM admin WHERE login_id = $1 FOR UPDATE`,
        [input.loginId],
      );
      const row = rows[0];
      if (!row) {
        // 없는 아이디도 같은 시간만큼 계산한다 (응답 속도로 아이디를 알아내지 못하게)
        await verifyPassword(undefined, input.password);
        return { kind: 'invalid_credentials' };
      }
      if (row.lock_seconds !== null) return { kind: 'locked', seconds: row.lock_seconds };

      if (!(await verifyPassword(row.password_hash, input.password))) {
        const seconds = await recordFailure(client, row.id);
        return seconds === null ? { kind: 'invalid_credentials' } : { kind: 'locked', seconds };
      }

      // 아직 OTP 앱을 연결하지 않은 관리자: 비밀번호만 맞으면 연결 단계로 보낸다
      if (!row.enrolled || !row.otp_secret) {
        await client.query('UPDATE admin SET failed_count = 0 WHERE id = $1', [row.id]);
        return { kind: 'setup', adminId: row.id, loginId: row.login_id };
      }

      // 연결한 뒤부터는 OTP 가 꼭 있어야 한다. 비워 보낸 건 추측이 아니라서 세지 않는다
      if (!input.otp) return { kind: 'invalid_otp' };
      const otpOk = await verifyOtp(
        { pool: client, redis: ctx.redis },
        { adminKey: row.id, secret: row.otp_secret, code: input.otp },
      );
      if (!otpOk) {
        const seconds = await recordFailure(client, row.id);
        return seconds === null ? { kind: 'invalid_otp' } : { kind: 'locked', seconds };
      }

      await client.query('UPDATE admin SET failed_count = 0, locked_until = NULL WHERE id = $1', [
        row.id,
      ]);
      return { kind: 'ok', adminId: row.id };
    });

    if (outcome.kind === 'invalid_credentials') {
      throw new AppError(401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 맞지 않아요');
    }
    if (outcome.kind === 'invalid_otp') throw new AppError(401, 'INVALID_OTP', 'OTP가 맞지 않아요');
    if (outcome.kind === 'locked') throw locked(outcome.seconds);
    if (outcome.kind === 'setup') {
      // 비밀 키는 연결이 끝날 때까지 DB 가 아니라 Redis 에 5분만 둔다. 끝내지 않으면 저절로 사라진다
      const secret = await newOtpSecret();
      const setupToken = randomBytes(32).toString('base64url');
      const state: SetupState = { adminId: outcome.adminId, loginId: outcome.loginId, secret };
      await ctx.redis.set(setupKey(setupToken), JSON.stringify(state), 'EX', SETUP_SECONDS);
      throw new AppError(403, 'OTP_SETUP_REQUIRED', 'OTP 앱을 먼저 연결해 주세요', {
        setupToken,
        otpauthUrl: otpauthUrl(outcome.loginId, secret),
      });
    }

    res.json(await issueTokens(ctx, outcome.adminId));
  });

  router.post('/admin/auth/otp/enroll', async (req, res) => {
    const input = parseBody(enrollSchema, req.body);
    const key = setupKey(input.setupToken);
    const raw = await ctx.redis.get(key);
    const expired = () =>
      new AppError(401, 'TOKEN_EXPIRED', 'OTP 연결 시간이 지났어요. 다시 로그인해 주세요');
    if (!raw) throw expired();
    const state = JSON.parse(raw) as SetupState;

    const ok = await verifyOtp(ctx, {
      adminKey: state.adminId,
      secret: state.secret,
      code: input.otp,
    });
    if (!ok) {
      // 연결 단계에서도 코드를 마구 넣어 보지 못하게 5번 틀리면 연결 정보를 지운다
      const tries = await ctx.redis.incr(`${key}:tries`);
      await ctx.redis.expire(`${key}:tries`, SETUP_SECONDS);
      if (tries >= MAX_SETUP_TRIES) await ctx.redis.del(key);
      throw new AppError(401, 'INVALID_OTP', 'OTP가 맞지 않아요');
    }

    // 이미 연결된 계정이면(다른 창에서 먼저 끝냄) 덮어쓰지 않는다
    const { rowCount } = await ctx.pool.query(
      `UPDATE admin SET otp_secret = $2, otp_enrolled_at = now(), failed_count = 0, locked_until = NULL
        WHERE id = $1 AND otp_enrolled_at IS NULL`,
      [state.adminId, state.secret],
    );
    await ctx.redis.del(key, `${key}:tries`);
    if (rowCount === 0) throw expired();

    res.json(await issueTokens(ctx, state.adminId));
  });

  return router;
}

// 관리자 API 입구. 이후 관리자 기능(가입 승인·병원 관리 등)은 이 확인을 거친다
export function requireAdmin(ctx: Pick<AdminContext, 'jwtKey'>): RequestHandler {
  return async (req, res, next) => {
    const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token)
      throw new AppError(401, 'TOKEN_REVOKED', '다시 로그인해 주세요');
    const verified = await verifyAdminAccessToken(ctx.jwtKey, token);
    if (!verified.ok) {
      if (verified.reason === 'expired') {
        throw new AppError(401, 'TOKEN_EXPIRED', '로그인 시간이 지났어요');
      }
      throw new AppError(401, 'TOKEN_REVOKED', '다시 로그인해 주세요');
    }
    res.locals.adminId = verified.adminId;
    next();
  };
}

export function adminId(res: Response): string {
  return res.locals.adminId as string;
}
