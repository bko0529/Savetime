// Express 앱 조립. 서버 켜기(index.ts)와 나눠서, 테스트가 포트·DB 없이 앱만 불러 쓸 수 있다.
import express from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Logger } from 'pino';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { serverNow } from './http/serverNow.js';
import { healthRouter, type HealthChecks } from './modules/ops/health.js';
import { hospitalDetailRouter } from './modules/transport/hospitalDetail.js';

export interface AppDeps {
  logger: Logger;
  healthChecks: HealthChecks;
  hospitalDetailPool?: pg.Pool;
}

export function createApp({ logger, healthChecks, hospitalDetailPool }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // 순서가 중요하다: 오류 응답에도 서버 시각이 붙도록 serverNow를 맨 앞에 둔다.
  app.use(serverNow);
  app.use(helmet());
  app.use(express.json());

  app.use(healthRouter(healthChecks));
  if (hospitalDetailPool) app.use('/api/v1', hospitalDetailRouter(hospitalDetailPool));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
