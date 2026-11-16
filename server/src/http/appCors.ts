// 구급대원 앱(Lovable 웹앱, CR-010)이 다른 주소에서 대원 API 를 부를 수 있게 하는 CORS.
// 브라우저는 다른 주소의 응답을, 서버가 'Access-Control-Allow-Origin: 그 주소'로 허락해야만 앱에 넘겨준다.
// - 허용 목록(APP_ORIGINS)에 있는 주소만 허락한다. '*'는 쓰지 않는다
// - 병원 웹(/hw)·관리자(/admin)에는 붙이지 않는다. 그쪽은 쿠키·Origin 검사로 지키는 같은 주소 웹이다 (SER-008)
// - 쿠키(credentials)는 허락하지 않는다. 대원 앱은 토큰을 Authorization 헤더로 보낸다
import type { RequestHandler } from 'express';

// 병원 웹·관리자 API 경로 (/api/v1 아래). 앱 주소로 와도 CORS 를 열지 않는다
const WEB_ONLY = /^\/(hw|admin)(\/|$)/;
// 브라우저가 확인 요청 결과를 기억하는 시간(초). 요청마다 OPTIONS 를 또 보내지 않게
const PREFLIGHT_MAX_AGE = 600;

export function appCors(allowed: string[]): RequestHandler {
  const origins = new Set(allowed);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin) || WEB_ONLY.test(req.path)) {
      next();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    // 주소마다 응답이 달라지므로, 중간 캐시가 다른 주소의 응답을 돌려주지 않게 한다
    res.vary('Origin');
    // 앱이 서버 시각으로 남은 시간을 보여 준다 (serverNow.ts). 브라우저는 열어 준 헤더만 앱에 보여 준다
    res.setHeader('Access-Control-Expose-Headers', 'X-Server-Now');

    // 확인 요청(preflight): Authorization 헤더나 JSON 을 보내기 전에 브라우저가 먼저 OPTIONS 로 묻는다
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      // Idempotency-Key: 이송 확정을 두 번 보내도 한 번만 되게 하는 헤더 (SFR-111). 빠지면 브라우저 앱의 확정이 막힌다
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE));
      res.status(204).end();
      return;
    }
    next();
  };
}
