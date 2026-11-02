import type { RequestHandler } from 'express';

// 모든 응답에 서버 시각을 붙여 앱·웹이 폰 시계 대신 이 값으로 남은 시간을 보여 준다.
// 화면 표시용이다. 2분·5분·5초 판정은 이 값이 아니라 DB now()로 한다 (SFR-160).
export const serverNow: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Server-Now', new Date().toISOString());
  next();
};
