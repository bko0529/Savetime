// GET /config: 앱·웹 설정 (QUR-013 기능 토글, SFR-142 앱 최소 버전). 로그인 없이 부른다.
// 앱은 켜질 때와 1분마다 읽어서, 꺼진 기능의 버튼을 숨기고 버전이 낮으면 '업데이트가 필요해요'만 보여 준다.
// 기능 토글은 관리자가 바꾸는 값이라 DB(feature_flag)에, 최소 버전은 서버를 배포할 때 같이 정하는 값이라 환경 변수에 둔다
import { Router } from 'express';
import type pg from 'pg';

// DB 키 → API 칸 이름. 표에 없는 키(옛 voice_input 등)는 내보내지 않는다
const FLAG_FIELDS: Record<string, 'journalAi' | 'hospitalGrade'> = {
  journal_ai: 'journalAi',
  hospital_grade: 'hospitalGrade',
};

export function configRouter(pool: pg.Pool, minAppVersion: string): Router {
  const router = Router();
  router.get('/config', async (_req, res) => {
    const { rows } = await pool.query<{ key: string; enabled: boolean; server_now: Date }>(
      'SELECT key, enabled, now() AS server_now FROM feature_flag',
    );
    // 표에 행이 없으면 꺼진 것으로 본다 (켜지 않은 기능이 실수로 보이지 않게)
    const featureFlags = { journalAi: false, hospitalGrade: false };
    for (const row of rows) {
      const field = FLAG_FIELDS[row.key];
      if (field) featureFlags[field] = row.enabled;
    }
    const serverNow =
      rows[0]?.server_now ?? (await pool.query<{ now: Date }>('SELECT now()')).rows[0].now;
    res.json({ featureFlags, minAppVersion, serverNow: serverNow.toISOString() });
  });
  return router;
}
