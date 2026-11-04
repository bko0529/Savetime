// 대원 API 입구. 모든 대원 API는 이 확인을 거친다 (SER-016).
import type { RequestHandler, Response } from 'express';
import { AppError } from '../../http/errors.js';
import { loadSessionState, type AuthContext, type ParamedicStatus } from './session.js';
import { verifyAccessToken } from './tokens.js';

export interface ParamedicAuth {
  paramedicId: string;
  status: ParamedicStatus;
}

export function paramedicAuth(res: Response): ParamedicAuth {
  return res.locals.auth as ParamedicAuth;
}

// 다시 로그인해야 하는 경우는 모두 같은 코드로 답한다. 왜 안 되는지(위조·만료·로그아웃) 밖에 알려 줄 필요가 없다.
const revoked = () => new AppError(401, 'TOKEN_REVOKED', '다시 로그인해 주세요');

// 접근 토큰 하나로 대원을 확인한다. REST(requireParamedic)와 실시간 연결(/app)이 같은 확인을 거친다.
export async function authenticateParamedic(
  ctx: AuthContext,
  token: string | undefined,
): Promise<ParamedicAuth> {
  if (!token) throw revoked();

  const verified = await verifyAccessToken(ctx.jwtKey, token);
  if (!verified.ok) {
    // 만료는 앱이 갱신 토큰으로 새 토큰을 받으면 된다
    if (verified.reason === 'expired') {
      throw new AppError(401, 'TOKEN_EXPIRED', '로그인 시간이 지났어요');
    }
    throw revoked();
  }

  // 토큰이 살아 있어도 그 뒤에 정지·로그아웃됐으면 세션 번호가 달라져 있다
  const { paramedicId, sessionVersion } = verified.claims;
  const state = await loadSessionState(ctx, paramedicId);
  if (!state || state.status === 'withdrawn' || state.sessionVersion !== sessionVersion) {
    throw revoked();
  }
  if (state.status === 'suspended') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', '정지된 계정이에요');
  }
  return { paramedicId, status: state.status };
}

export function requireParamedic(ctx: AuthContext): RequestHandler {
  return async (req, res, next) => {
    const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
    res.locals.auth = await authenticateParamedic(ctx, scheme === 'Bearer' ? token : undefined);
    next();
  };
}

// 가입 승인 전·반려 계정은 로그인과 내 정보 확인만 할 수 있다 (SFR-022·083)
export const requireApproved: RequestHandler = (_req, res, next) => {
  if (paramedicAuth(res).status !== 'approved') {
    throw new AppError(403, 'NOT_APPROVED', '가입 승인 후에 쓸 수 있어요');
  }
  next();
};
