// 대원 로그인·토큰 재발급·로그아웃·내 정보 (SFR-018, SFR-070, SER-016, SER-007)
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { endDuty } from '../team/endDuty.js';
import { paramedicAuth, requireParamedic } from './guards.js';
import { loadMe } from './me.js';
import { hashPassword, verifyPassword } from './password.js';
import { forgetSessionState, type AuthContext, type ParamedicStatus } from './session.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from './tokens.js';
import type { Realtime } from '../realtime/server.js';
import { withdrawParamedic } from './withdraw.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 10;

const loginSchema = z.object({
  loginId: z.string().min(1).max(40),
  password: z.string().min(1).max(200),
  deviceId: z.string().min(1).max(80),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1).max(100) });

// 새 비밀번호 길이는 가입과 같다: 8자 이상 (signup.ts)
export const PASSWORD_MIN = 8;
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(PASSWORD_MIN).max(200),
});

// FCM 토큰은 길이가 정해져 있지 않다. 넉넉히 받되 끝없이 받지는 않는다
const pushDeviceSchema = z.object({
  deviceId: z.string().min(1).max(80),
  // web: 구급대원 웹앱의 브라우저 푸시 토큰 (CR-010)
  platform: z.enum(['android', 'ios', 'web']),
  fcmToken: z.string().min(1).max(4096),
});

interface LoginRow {
  id: string;
  password_hash: string;
  status: ParamedicStatus;
  session_version: number;
  lock_seconds: number | null;
}

type LoginOutcome =
  | { kind: 'ok'; paramedicId: string; sessionVersion: number; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'locked'; seconds: number }
  | { kind: 'suspended' };

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 맞지 않아요');

function locked(seconds: number): AppError {
  return new AppError(423, 'ACCOUNT_LOCKED', '로그인을 잠시 막았어요', {
    retryAfterSeconds: seconds,
  });
}

// 비밀번호를 틀렸다: 실패 횟수를 1 올리고, 5번째면 10분 잠근다. 잠갔으면 남은 초, 아니면 null.
// 로그인과 비밀번호 변경(PUT /me/password)이 같은 횟수를 쓴다. 둘 중 어디로든 비밀번호를 맞혀 보지 못하게 (SER-011)
async function recordPasswordFailure(client: pg.PoolClient, paramedicId: string) {
  const { rows } = await client.query<{ lock_seconds: number | null }>(
    `UPDATE paramedic
        SET failed_count = CASE WHEN failed_count + 1 >= $2 THEN 0 ELSE failed_count + 1 END,
            locked_until = CASE WHEN failed_count + 1 >= $2
                                THEN now() + make_interval(mins => $3) END
      WHERE id = $1
     RETURNING CASE WHEN locked_until IS NOT NULL
                    THEN ceil(extract(epoch FROM locked_until - now()))::int END AS lock_seconds`,
    [paramedicId, MAX_FAILURES, LOCK_MINUTES],
  );
  return rows[0].lock_seconds;
}

// 로그인 때는 지금부터 근무 시간만큼, 재발급 때는 바꾸는 토큰(previousId)의 만료 시각을 그대로 쓴다.
async function issueRefreshToken(
  client: pg.PoolClient,
  paramedicId: string,
  deviceId: string | null,
  expires: { shiftHours: number } | { previousId: string },
): Promise<string> {
  const token = newRefreshToken();
  await client.query(
    `INSERT INTO refresh_token (owner_type, owner_id, token_hash, device_id, expires_at)
     VALUES ('paramedic', $1, $2, $3,
             coalesce((SELECT expires_at FROM refresh_token WHERE id = $4),
                      now() + make_interval(hours => $5)))`,
    [
      paramedicId,
      hashRefreshToken(token),
      deviceId,
      'previousId' in expires ? expires.previousId : null,
      'shiftHours' in expires ? expires.shiftHours : null,
    ],
  );
  return token;
}

export function authRouter(ctx: AuthContext, realtime?: Realtime): Router {
  const router = Router();

  router.post('/auth/login', async (req, res) => {
    const input = parseBody(loginSchema, req.body);

    // 같은 계정의 로그인 시도를 한 줄로 세운다 (FOR UPDATE). 동시에 틀려도 실패 횟수가 빠지지 않는다.
    // 실패 횟수는 저장해야 하므로 오류를 트랜잭션 안에서 던지지 않고 결과만 돌려준 뒤 밖에서 던진다.
    // 안에서 던지면 롤백되어 '5번 틀리면 잠금'이 영영 안 걸린다.
    const outcome = await withTransaction(ctx.pool, async (client): Promise<LoginOutcome> => {
      const { rows } = await client.query<LoginRow>(
        `SELECT id, password_hash, status, session_version,
                CASE WHEN locked_until > now()
                     THEN ceil(extract(epoch FROM locked_until - now()))::int END AS lock_seconds
           FROM paramedic WHERE login_id = $1 FOR UPDATE`,
        [input.loginId],
      );
      const row = rows[0];
      if (!row || row.status === 'withdrawn') {
        await verifyPassword(undefined, input.password);
        return { kind: 'invalid' };
      }
      // 잠긴 동안은 맞는 비밀번호여도 들여보내지 않는다. 시간 판정은 DB 시각 기준 (SFR-160)
      if (row.lock_seconds !== null) return { kind: 'locked', seconds: row.lock_seconds };

      if (!(await verifyPassword(row.password_hash, input.password))) {
        const seconds = await recordPasswordFailure(client, row.id);
        return seconds === null ? { kind: 'invalid' } : { kind: 'locked', seconds };
      }

      await client.query(
        'UPDATE paramedic SET failed_count = 0, locked_until = NULL WHERE id = $1',
        [row.id],
      );
      // 정지 여부는 비밀번호가 맞을 때만 알려 준다. 틀린 비밀번호로 계정 상태를 캐 볼 수 없게 한다.
      if (row.status === 'suspended') return { kind: 'suspended' };

      // 로그인 = 근무 시작. 갱신 토큰은 로그인부터 최대 14시간만 쓴다 (SER-007)
      const refreshToken = await issueRefreshToken(client, row.id, input.deviceId, {
        shiftHours: ctx.shiftHours,
      });
      return {
        kind: 'ok',
        paramedicId: row.id,
        sessionVersion: row.session_version,
        refreshToken,
      };
    });

    if (outcome.kind === 'invalid') throw invalidCredentials();
    if (outcome.kind === 'locked') throw locked(outcome.seconds);
    if (outcome.kind === 'suspended') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', '정지된 계정이에요');
    }

    const accessToken = await signAccessToken(ctx.jwtKey, outcome);
    res.json({
      tokens: { accessToken, refreshToken: outcome.refreshToken },
      me: await loadMe(ctx.pool, outcome.paramedicId),
    });
  });

  router.post('/auth/refresh', async (req, res) => {
    const { refreshToken } = parseBody(refreshSchema, req.body);

    const issued = await withTransaction(ctx.pool, async (client) => {
      const { rows } = await client.query<{
        id: string;
        owner_id: string;
        device_id: string | null;
        revoked: boolean;
        expired: boolean;
        status: ParamedicStatus;
        session_version: number;
      }>(
        `SELECT t.id, t.owner_id, t.device_id, t.revoked_at IS NOT NULL AS revoked,
                t.expires_at <= now() AS expired, p.status, p.session_version
           FROM refresh_token t
           JOIN paramedic p ON p.id = t.owner_id
          WHERE t.token_hash = $1 AND t.owner_type = 'paramedic'
          FOR UPDATE OF t`,
        [hashRefreshToken(refreshToken)],
      );
      const row = rows[0];
      // 이미 바꿔 준 토큰을 다시 내밀면 거절한다. 같은 토큰으로 동시에 두 번 와도 한 번만 바꿔 준다 (FOR UPDATE)
      if (!row || row.revoked || row.status === 'withdrawn') {
        throw new AppError(401, 'TOKEN_REVOKED', '다시 로그인해 주세요');
      }
      if (row.expired)
        throw new AppError(401, 'TOKEN_EXPIRED', '근무 시간이 지나 다시 로그인해 주세요');
      if (row.status === 'suspended') {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', '정지된 계정이에요');
      }

      // 쓸 때마다 새 토큰으로 바꾼다. 만료 시각은 그대로 둬서 근무 14시간을 넘겨 늘어나지 않게 한다.
      await client.query('UPDATE refresh_token SET revoked_at = now() WHERE id = $1', [row.id]);
      const next = await issueRefreshToken(client, row.owner_id, row.device_id, {
        previousId: row.id,
      });
      return { paramedicId: row.owner_id, sessionVersion: row.session_version, refreshToken: next };
    });

    res.json({
      accessToken: await signAccessToken(ctx.jwtKey, issued),
      refreshToken: issued.refreshToken,
    });
  });

  // 로그아웃 = 근무 종료와 같은 처리 (SFR-070). 승인 전 계정도 로그아웃은 할 수 있어야 해서 승인 확인은 붙이지 않는다.
  router.post('/auth/logout', requireParamedic(ctx), async (req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const confirmCancelActive = req.query.confirmCancelActive === 'true';
    const { events } = await withTransaction(ctx.pool, (client) =>
      endDuty(client, ctx, paramedicId, 'logout', confirmCancelActive),
    );
    // 마지막 1명이라 이송이 취소됐으면 병원 웹에도 '이송 취소'를 알린다 (커밋 뒤)
    realtime?.publish(events);
    // 커밋 전에 지운 캐시에 그사이 옛 값이 다시 들어갔을 수 있어 한 번 더 지운다
    await forgetSessionState(ctx, paramedicId);
    // 이 대원의 실시간 연결도 끊는다. 토큰이 막혀서 다시 붙지 못한다 (SER-016)
    await realtime?.disconnectParamedic(paramedicId);
    res.status(204).end();
  });

  // 푸시 받을 기기 등록 (SFR-130, COR-009). 앱이 시작할 때와 FCM 토큰이 바뀔 때마다 부른다.
  // 대원·기기마다 1개: 같은 기기면 토큰만 바꾼다. 승인 전에도 가입 결과 푸시(SFR-083)를 받아야 해서 승인 확인은 붙이지 않는다
  router.put('/me/push-device', requireParamedic(ctx), async (req, res) => {
    const input = parseBody(pushDeviceSchema, req.body);
    await ctx.pool.query(
      `INSERT INTO push_device (paramedic_id, device_id, platform, fcm_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (paramedic_id, device_id)
       DO UPDATE SET platform = excluded.platform, fcm_token = excluded.fcm_token, updated_at = now()`,
      [paramedicAuth(res).paramedicId, input.deviceId, input.platform, input.fcmToken],
    );
    res.status(204).end();
  });

  // 비밀번호 변경 (SFR-021). 관리자가 초기화한 임시 비밀번호로 들어오면 이것부터 해야 다른 기능이 열린다.
  // 승인 확인(requireApproved)을 붙이지 않는다: 임시 비밀번호 상태에서도 이 API 는 써야 하므로
  router.put('/me/password', requireParamedic(ctx), async (req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const input = parseBody(changePasswordSchema, req.body);
    if (input.newPassword === input.currentPassword) {
      throw new AppError(400, 'VALIDATION_FAILED', '지금 비밀번호와 다른 비밀번호를 정해 주세요', {
        fields: ['newPassword'],
      });
    }
    // 새 비밀번호는 잠금 밖에서 미리 계산한다 (argon2 는 일부러 느려서 잠근 채 오래 붙잡지 않게)
    const newHash = await hashPassword(input.newPassword);
    // 로그인과 같은 이유로 오류를 트랜잭션 밖에서 던진다 (안에서 던지면 실패 횟수가 롤백된다)
    const outcome = await withTransaction(
      ctx.pool,
      async (
        client,
      ): Promise<{ kind: 'ok' } | { kind: 'invalid' } | { kind: 'locked'; seconds: number }> => {
        const { rows } = await client.query<{ password_hash: string; lock_seconds: number | null }>(
          `SELECT password_hash,
                  CASE WHEN locked_until > now()
                       THEN ceil(extract(epoch FROM locked_until - now()))::int END AS lock_seconds
             FROM paramedic WHERE id = $1 FOR UPDATE`,
          [paramedicId],
        );
        const row = rows[0];
        // 잠긴 동안은 맞는 비밀번호여도 바꾸지 않는다 (DB 시각 기준)
        if (row?.lock_seconds != null) return { kind: 'locked', seconds: row.lock_seconds };
        if (!(await verifyPassword(row?.password_hash, input.currentPassword))) {
          if (!row) return { kind: 'invalid' };
          const seconds = await recordPasswordFailure(client, paramedicId);
          return seconds === null ? { kind: 'invalid' } : { kind: 'locked', seconds };
        }
        await client.query(
          `UPDATE paramedic SET password_hash = $2, must_change_pw = false, failed_count = 0, locked_until = NULL
            WHERE id = $1`,
          [paramedicId, newHash],
        );
        return { kind: 'ok' };
      },
    );
    if (outcome.kind === 'locked') throw locked(outcome.seconds);
    if (outcome.kind === 'invalid') throw invalidCredentials();
    // 계정 상태 캐시를 지워 다음 요청부터 '변경 필요'가 풀린 상태로 본다
    await forgetSessionState(ctx, paramedicId);
    res.status(204).end();
  });

  router.get('/me', requireParamedic(ctx), async (_req, res) => {
    const me = await loadMe(ctx.pool, paramedicAuth(res).paramedicId);
    if (!me) throw new AppError(401, 'TOKEN_REVOKED', '다시 로그인해 주세요');
    res.json(me);
  });

  // 회원 탈퇴 (SFR-071). 승인 전·반려 계정도 탈퇴할 수 있어야 해서 승인 확인은 붙이지 않는다.
  router.delete('/me', requireParamedic(ctx), async (req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const confirmCancelActive = req.query.confirmCancelActive === 'true';
    const events = await withTransaction(ctx.pool, (client) =>
      withdrawParamedic(client, ctx, paramedicId, confirmCancelActive),
    );
    realtime?.publish(events);
    await forgetSessionState(ctx, paramedicId);
    // 이 대원의 실시간 연결도 끊는다. 토큰이 막혀서 다시 붙지 못한다 (SER-016)
    await realtime?.disconnectParamedic(paramedicId);
    res.status(204).end();
  });

  return router;
}
