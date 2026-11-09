// 관리자 API 접속 IP 제한 (T-11, SER-010). 앞단 Caddy 도 허용 IP 만 통과시키지만,
// Caddy 설정을 실수로 빠뜨려도 관리자 API 가 열리지 않게 서버에서도 한 번 더 막는다 (가장 센 권한이라서).
// req.ip 는 app.ts 의 'trust proxy' 덕분에 Caddy 뒤에서도 실제 접속 주소다
import type { RequestHandler } from 'express';
import { AppError } from '../../http/errors.js';

// IPv4 주소가 IPv6 모양(::ffff:1.2.3.4)으로 들어와도 같은 주소로 본다
const normalize = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);

// 목록이 비어 있으면 검사하지 않는다 (개발·테스트). 운영 관리자 서버는 index.ts 가 빈 목록으로 켜지지 않게 막는다
export function adminIpGuard(allowed: string[]): RequestHandler {
  const ips = new Set(allowed.map(normalize));
  return (req, _res, next) => {
    if (ips.size === 0 || ips.has(normalize(req.ip ?? ''))) {
      next();
      return;
    }
    // 어떤 IP 가 허용되는지 알려 주지 않는다
    next(new AppError(403, 'IP_NOT_ALLOWED', '이 주소에서는 관리자 화면을 쓸 수 없어요'));
  };
}
