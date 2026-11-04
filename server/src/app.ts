// Express 앱 조립. 서버 켜기(index.ts)와 나눠서, 테스트가 포트·DB 없이 앱만 불러 쓸 수 있다.
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { serverNow } from './http/serverNow.js';
import { requireApproved, requireParamedic } from './modules/auth/guards.js';
import { authRouter } from './modules/auth/routes.js';
import type { AuthContext } from './modules/auth/session.js';
import { auditRouter } from './modules/admin/audit.js';
import { adminAuthRouter, requireAdmin, type AdminContext } from './modules/admin/auth.js';
import { adminHospitalRouter } from './modules/admin/hospitals.js';
import type { HospitalWebContext } from './modules/hospital-web/pcAuth.js';
import { hospitalWebRouter } from './modules/hospital-web/routes.js';
import { healthRouter, type HealthChecks } from './modules/ops/health.js';
import { teamRouter } from './modules/team/routes.js';
import { geocodeRouter, type Geocoder } from './modules/transport/geocode.js';
import { hospitalDetailRouter } from './modules/transport/hospitalDetail.js';
import type { EtaLookup } from './modules/transport/eta.js';
import { recommendRouter } from './modules/transport/recommend.js';
import { transportRouter } from './modules/transport/create.js';
import type { Realtime } from './modules/realtime/server.js';

export interface AppDeps {
  logger: Logger;
  healthChecks: HealthChecks;
  // 없으면 /health만 켠다 (관리자 서버·테스트)
  auth?: AuthContext;
  // 실시간 서버. 없으면(테스트·관리자 서버) 이벤트는 기록만 되고 보내지 않는다
  realtime?: Realtime;
  // 카카오 키가 없으면 비워 둔다. 예상 이동시간만 빠진다 (SFR-073)
  eta?: EtaLookup;
  // 카카오 키가 없으면 비워 둔다. 주소→좌표만 503이 된다
  geocoder?: Geocoder;
  // 없으면 병원 웹 API(/hw)를 켜지 않는다 (관리자 서버·테스트)
  hospitalWeb?: HospitalWebContext;
  // 없으면 관리자 API(/admin)를 켜지 않는다
  admin?: AdminContext;
}

export function createApp({
  logger,
  healthChecks,
  auth,
  eta,
  geocoder,
  realtime,
  hospitalWeb,
  admin,
}: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Caddy·로드밸런서(사설망)를 거쳐 와도 req.ip 가 실제 접속 주소가 되게 한다.
  // 안 하면 모든 병원이 프록시 주소 하나로 보여, 한 곳의 키 실패가 전체를 막는다 (SER-011)
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  // 순서가 중요하다: 오류 응답에도 서버 시각이 붙도록 serverNow를 맨 앞에 둔다.
  app.use(serverNow);
  app.use(helmet());
  app.use(express.json());

  app.use(healthRouter(healthChecks));
  if (auth) {
    // 로그인한 승인 대원만 쓰는 API에 붙인다. 로그인·재발급·내 정보는 그 전 단계라 따로 둔다.
    const approvedParamedic = [requireParamedic(auth), requireApproved];
    app.use('/api/v1', authRouter(auth, realtime));
    app.use('/api/v1', teamRouter(auth, approvedParamedic, realtime));
    // /hospitals/nearby가 /hospitals/:hospitalId보다 먼저 와야 'nearby'를 병원 ID로 읽지 않는다
    app.use('/api/v1', recommendRouter(auth.pool, approvedParamedic, eta));
    app.use('/api/v1', hospitalDetailRouter(auth.pool, approvedParamedic));
    app.use('/api/v1', geocodeRouter(approvedParamedic, geocoder));
    app.use('/api/v1', transportRouter(auth.pool, approvedParamedic, realtime));
  }
  if (hospitalWeb) {
    app.use('/api/v1', hospitalWebRouter(hospitalWeb));
  }
  if (admin) {
    // adminAuthRouter 가 /admin 전체에 Origin 검사를 건다. 그래서 로그인 라우터를 맨 앞에 둔다
    app.use('/api/v1', adminAuthRouter(admin));
    // 로그인 말고는 모두 관리자 토큰이 있어야 한다 (SER-010)
    const adminOnly = requireAdmin(admin);
    app.use('/api/v1', adminHospitalRouter(admin.pool, adminOnly));
    app.use('/api/v1', auditRouter(admin.pool, adminOnly));
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
