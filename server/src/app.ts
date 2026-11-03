// Express 앱 조립. 서버 켜기(index.ts)와 나눠서, 테스트가 포트·DB 없이 앱만 불러 쓸 수 있다.
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { serverNow } from './http/serverNow.js';
import { requireApproved, requireParamedic } from './modules/auth/guards.js';
import { authRouter } from './modules/auth/routes.js';
import type { AuthContext } from './modules/auth/session.js';
import { healthRouter, type HealthChecks } from './modules/ops/health.js';
import { hospitalDetailRouter } from './modules/transport/hospitalDetail.js';
import type { EtaLookup } from './modules/transport/eta.js';
import { recommendRouter } from './modules/transport/recommend.js';

export interface AppDeps {
  logger: Logger;
  healthChecks: HealthChecks;
  // 없으면 /health만 켠다 (관리자 서버·테스트)
  auth?: AuthContext;
  // 카카오 키가 없으면 비워 둔다. 예상 이동시간만 빠진다 (SFR-073)
  eta?: EtaLookup;
}

export function createApp({ logger, healthChecks, auth, eta }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // 순서가 중요하다: 오류 응답에도 서버 시각이 붙도록 serverNow를 맨 앞에 둔다.
  app.use(serverNow);
  app.use(helmet());
  app.use(express.json());

  app.use(healthRouter(healthChecks));
  if (auth) {
    // 로그인한 승인 대원만 쓰는 API에 붙인다. 로그인·재발급·내 정보는 그 전 단계라 따로 둔다.
    const approvedParamedic = [requireParamedic(auth), requireApproved];
    app.use('/api/v1', authRouter(auth));
    // /hospitals/nearby가 /hospitals/:hospitalId보다 먼저 와야 'nearby'를 병원 ID로 읽지 않는다
    app.use('/api/v1', recommendRouter(auth.pool, approvedParamedic, eta));
    app.use('/api/v1', hospitalDetailRouter(auth.pool, approvedParamedic));
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
