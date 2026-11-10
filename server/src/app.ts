// Express 앱 조립. 서버 켜기(index.ts)와 나눠서, 테스트가 포트·DB 없이 앱만 불러 쓸 수 있다.
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { appCors } from './http/appCors.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { serverNow } from './http/serverNow.js';
import { requireApproved, requireParamedic } from './modules/auth/guards.js';
import { authRouter } from './modules/auth/routes.js';
import type { AuthContext } from './modules/auth/session.js';
import { auditRouter } from './modules/admin/audit.js';
import { adminAuthRouter, requireAdmin, type AdminContext } from './modules/admin/auth.js';
import { adminIpGuard } from './modules/admin/ipGuard.js';
import { adminHospitalRouter } from './modules/admin/hospitals.js';
import { adminNotificationRouter } from './modules/admin/notifications.js';
import { adminParamedicRouter } from './modules/admin/paramedics.js';
import { adminSignupRouter } from './modules/admin/signups.js';
import { adminStatsRouter } from './modules/admin/stats.js';
import { adminPcRouter } from './modules/admin/pcs.js';
import type { HospitalWebContext } from './modules/hospital-web/pcAuth.js';
import { hospitalWebRouter } from './modules/hospital-web/routes.js';
import { configRouter } from './modules/ops/config.js';
import { healthRouter, type HealthChecks } from './modules/ops/health.js';
import { memoRouter } from './modules/team/memos.js';
import { draftRouter } from './modules/team/draft.js';
import { inviteRouter } from './modules/team/invites.js';
import { teamRouter } from './modules/team/routes.js';
import { geocodeRouter, type Geocoder } from './modules/transport/geocode.js';
import { hospitalDetailRouter } from './modules/transport/hospitalDetail.js';
import type { EtaLookup } from './modules/transport/eta.js';
import { recommendRouter } from './modules/transport/recommend.js';
import { confirmRouter } from './modules/transport/confirm.js';
import { journalRouter } from './modules/transport/journal.js';
import { syncRouter } from './modules/transport/sync.js';
import { locationRouter } from './modules/transport/route.js';
import { phoneCheckRouter } from './modules/transport/phoneCheck.js';
import { roundsRouter } from './modules/transport/rounds.js';
import { assessmentSendRouter } from './modules/transport/assessmentSend.js';
import { navDeviceRouter } from './modules/transport/navDevice.js';
import { finishRouter } from './modules/transport/finish.js';
import { transportRouter } from './modules/transport/create.js';
import type { Realtime } from './modules/realtime/server.js';
import type { PhotoStore } from './modules/auth/photoStore.js';
import { signupRouter } from './modules/auth/signup.js';

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
  // 사진 저장소 설정이 없으면 비워 둔다. 가입 신청만 503 이 된다 (SFR-017)
  photos?: PhotoStore;
  // 구급대원 앱(웹앱) 주소. 여기 있는 주소에서 온 대원 API 요청만 CORS 로 허락한다 (CR-010)
  appOrigins?: string[];
  // 앱 최소 지원 버전 (MIN_APP_VERSION, SFR-142). 이보다 낮은 앱은 '업데이트가 필요해요'만 보여 준다
  minAppVersion?: string;
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
  photos,
  appOrigins = [],
  minAppVersion = '1.0.0',
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
  // 라우터보다 먼저: 401·404 같은 오류 응답에도 CORS 가 붙어야 앱이 오류 코드를 읽는다
  app.use('/api/v1', appCors(appOrigins));

  app.use(healthRouter(healthChecks));
  if (auth) {
    // 로그인한 승인 대원만 쓰는 API에 붙인다. 로그인·재발급·내 정보는 그 전 단계라 따로 둔다.
    const approvedParamedic = [requireParamedic(auth), requireApproved];
    // 앱·웹 설정은 로그인 없이 (QUR-013, SFR-142)
    app.use('/api/v1', configRouter(auth.pool, minAppVersion));
    app.use('/api/v1', authRouter(auth, realtime));
    app.use('/api/v1', signupRouter(auth, photos));
    app.use('/api/v1', teamRouter(auth, approvedParamedic, realtime));
    app.use('/api/v1', inviteRouter(auth, approvedParamedic, realtime));
    app.use('/api/v1', memoRouter(auth.pool, approvedParamedic));
    app.use('/api/v1', draftRouter(auth, approvedParamedic, realtime));
    // /hospitals/nearby가 /hospitals/:hospitalId보다 먼저 와야 'nearby'를 병원 ID로 읽지 않는다
    app.use('/api/v1', recommendRouter(auth.pool, approvedParamedic, eta));
    app.use('/api/v1', hospitalDetailRouter(auth.pool, approvedParamedic));
    app.use('/api/v1', geocodeRouter(approvedParamedic, geocoder));
    app.use('/api/v1', transportRouter(auth.pool, approvedParamedic, realtime, eta));
    app.use('/api/v1', confirmRouter(auth, approvedParamedic, realtime));
    app.use('/api/v1', finishRouter(auth.pool, approvedParamedic, realtime));
    app.use('/api/v1', locationRouter(auth.pool, approvedParamedic, realtime));
    app.use('/api/v1', journalRouter(auth.pool, approvedParamedic));
    app.use('/api/v1', syncRouter(auth.pool, approvedParamedic, realtime));
    app.use('/api/v1', phoneCheckRouter(auth.pool, approvedParamedic, realtime));
    app.use('/api/v1', roundsRouter(auth.pool, approvedParamedic, realtime, eta));
    app.use('/api/v1', assessmentSendRouter(auth.pool, approvedParamedic, realtime));
    app.use('/api/v1', navDeviceRouter(auth.pool, approvedParamedic, realtime));
  }
  if (hospitalWeb) {
    app.use('/api/v1', hospitalWebRouter(hospitalWeb));
  }
  if (admin) {
    // 허용 IP 가 아니면 로그인부터 막는다 (T-11). 그래서 IP 검사를 맨 앞에 둔다
    app.use('/api/v1/admin', adminIpGuard(admin.allowedIps ?? []));
    // adminAuthRouter 가 /admin 전체에 Origin 검사를 건다. 그래서 로그인 라우터를 맨 앞에 둔다
    app.use('/api/v1', adminAuthRouter(admin));
    // 로그인 말고는 모두 관리자 토큰이 있어야 한다 (SER-010)
    const adminOnly = requireAdmin(admin);
    app.use('/api/v1', adminHospitalRouter(admin.pool, adminOnly, realtime));
    app.use('/api/v1', auditRouter(admin.pool, adminOnly));
    app.use('/api/v1', adminPcRouter(admin.pool, adminOnly, realtime));
    app.use('/api/v1', adminNotificationRouter(admin.pool, adminOnly));
    app.use('/api/v1', adminParamedicRouter(admin.pool, admin.redis, adminOnly, realtime));
    app.use('/api/v1', adminSignupRouter(admin.pool, admin.redis, adminOnly, photos, realtime));
    app.use('/api/v1', adminStatsRouter(admin.pool, adminOnly));
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
