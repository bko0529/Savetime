// 관리자 기능 토글 (QUR-013, A-02): AI 일지 정리·병원 등급 선택을 배포 없이 켜고 끈다.
// 앱·웹은 GET /config 로 1분마다 읽으니 바꾸면 1분 안에 반영된다. 바꿀 때마다 작업 이력에 남긴다 (SFR-091)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { adminId } from './auth.js';
import { recordAudit } from './audit.js';

// API 칸 이름 → DB 키 · 작업 이력에 남길 이름
const FLAGS = {
  journalAi: { key: 'journal_ai', label: 'AI 일지 정리' },
  hospitalGrade: { key: 'hospital_grade', label: '병원 등급 선택' },
} as const;
type FlagField = keyof typeof FLAGS;
type Flags = Record<FlagField, boolean>;

const putSchema = z
  .object({ journalAi: z.boolean().optional(), hospitalGrade: z.boolean().optional() })
  .strict();

type Db = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

// 표에 행이 없으면 꺼진 것으로 본다 (GET /config 와 같은 규칙)
async function readFlags(db: Db): Promise<Flags> {
  const { rows } = await db.query<{ key: string; enabled: boolean }>(
    'SELECT key, enabled FROM feature_flag',
  );
  const out: Flags = { journalAi: false, hospitalGrade: false };
  for (const field of Object.keys(FLAGS) as FlagField[]) {
    out[field] = rows.find((r) => r.key === FLAGS[field].key)?.enabled ?? false;
  }
  return out;
}

export function adminFeatureFlagRouter(pool: pg.Pool, adminOnly: RequestHandler): Router {
  const router = Router();

  router.get('/admin/feature-flags', adminOnly, async (_req, res) => {
    res.json(await readFlags(pool));
  });

  router.put('/admin/feature-flags', adminOnly, async (req, res) => {
    const input = parseBody(putSchema, req.body);
    const fields = (Object.keys(FLAGS) as FlagField[]).filter((f) => input[f] !== undefined);
    if (fields.length === 0) {
      throw new AppError(400, 'VALIDATION_FAILED', '바꿀 기능을 골라 주세요', {
        fields: Object.keys(FLAGS),
      });
    }
    const flags = await withTransaction(pool, async (client) => {
      for (const field of fields) {
        const enabled = input[field]!;
        // 값이 실제로 바뀐 경우에만 행을 고치고 이력을 남긴다 (같은 값으로 두 번 눌러도 이력 1줄).
        // 키 행을 잠가 두 관리자가 동시에 눌러도 한 줄로 선다
        const { rows } = await client.query<{ changed: boolean }>(
          `INSERT INTO feature_flag (key, enabled, updated_at, updated_by) VALUES ($1, $2, now(), $3)
           ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by
             WHERE feature_flag.enabled IS DISTINCT FROM excluded.enabled
           RETURNING true AS changed`,
          [FLAGS[field].key, enabled, adminId(res)],
        );
        if (!rows[0]) continue;
        await recordAudit(client, {
          adminId: adminId(res),
          action: enabled ? 'enable_feature' : 'disable_feature',
          targetType: 'feature_flag',
          targetId: null,
          targetName: FLAGS[field].label,
        });
      }
      return readFlags(client);
    });
    res.json(flags);
  });

  return router;
}
