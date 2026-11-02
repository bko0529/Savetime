// GET /health: 로드밸런서가 죽은 서버를 빼는 기준 + 외부 상태 점검 (QUR-009, COR-016)
import { Router } from 'express';

export type HealthCheck = () => Promise<unknown>;
export type HealthChecks = Record<string, HealthCheck>;

const CHECK_TIMEOUT_MS = 2000;

// DB가 멈춰 응답을 안 주면 점검도 같이 멈춘다. 시간 제한을 둬서 '실패'로 빨리 판정한다.
async function runCheck(check: HealthCheck): Promise<'ok' | 'error'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

export function healthRouter(checks: HealthChecks): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const names = Object.keys(checks);
    const results = await Promise.all(names.map((name) => runCheck(checks[name])));
    const ok = results.every((result) => result === 'ok');

    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'error',
      checks: Object.fromEntries(names.map((name, i) => [name, results[i]])),
    });
  });

  return router;
}
