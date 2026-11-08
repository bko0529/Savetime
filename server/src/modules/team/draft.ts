// 팀 작성 중 환자 정보 (SFR-114) · 주행 중 운전자 입력 잠금 (SFR-115).
// - 팀마다 서버에 1개만 두고 팀원 단말이 같이 고친다. 바뀐 칸만 받아 합치고, 버전이 달라도 거절하지 않는다
//   (흔들리는 차 안에서 "다시 불러오세요"로 막으면 입력이 끊긴다). 같은 칸을 동시에 고치면 나중 값이 남고 알린다
// - 팀원에게는 draft.updated 로 "어느 칸이 바뀌었는지"만 보낸다. 값은 환자 정보라 이벤트에 넣지 않고(규칙 5) 앱이 GET 으로 읽는다
// - 운전 역할이 시속 10km 이상으로 달리는 중이면 막는다. 앱이 먼저 잠그고, 서버가 한 번 더 본다
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { ACTIVE } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import type { AuthContext } from '../auth/session.js';
import { appendEvents } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { assessmentChangesSchema } from '../transport/assessment.js';
import { clearExpiredPrevPatient, prevPatientState } from './prevPatient.js';

// 이 속도 이상이면 주행 중 (SFR-115)
export const DRIVING_KMH = 10;
// 위치 기록으로 볼 때 이만큼 지난 기록은 '지금 속도'로 보지 않는다
const RECENT_SPEED_SECONDS = 15;

const patchSchema = z.object({
  baseVersion: z.number().int().min(0),
  changes: assessmentChangesSchema.refine((c) => Object.keys(c).length > 0, {
    message: '바뀐 칸이 없어요',
  }),
  // 단말이 잰 지금 속도 (운전 역할 잠금 확인용, 선택)
  speedKmh: z.number().min(0).max(300).optional(),
});

// 칸마다 마지막으로 고친 사람·시각·그때의 버전
interface FieldMeta {
  by: string;
  byName: string;
  at: string;
  version: number;
}
type Data = Record<string, unknown>;
interface DraftRow {
  data: Data;
  field_meta: Record<string, FieldMeta>;
  version: number;
}

const notInTeam = () => new AppError(404, 'NOT_IN_TEAM', '근무 중인 팀이 없어요');

async function myMembership(db: pg.Pool | pg.PoolClient, paramedicId: string) {
  const { rows } = await db.query<{ team_id: string; role: 'driver' | 'care'; name: string }>(
    `SELECT m.team_id, m.role, p.name
       FROM team_member m JOIN paramedic p ON p.id = m.paramedic_id
      WHERE m.paramedic_id = $1 AND m.left_at IS NULL`,
    [paramedicId],
  );
  if (!rows[0]) throw notInTeam();
  return rows[0];
}

// 화면에는 고친 사람 이름과 시각만 (계정 id 는 내보내지 않는다)
function publicMeta(meta: Record<string, FieldMeta>) {
  return Object.fromEntries(
    Object.entries(meta).map(([field, m]) => [field, { byName: m.byName, at: m.at }]),
  );
}

// 운전 역할이 달리는 중인지: 단말이 보낸 속도, 또는 진행 중 이송 건의 최근 위치 기록 속도 (DB 시각 기준)
async function isDriving(
  client: pg.PoolClient,
  teamId: string,
  speedKmh: number | undefined,
): Promise<boolean> {
  // 단말이 보낸 속도가 있으면 그 값을 믿는다 (정차하면 바로 입력, SFR-115)
  if (speedKmh !== undefined) return speedKmh >= DRIVING_KMH;
  const { rows } = await client.query<{ speed: number | null }>(
    `SELECT lp.speed_kmh::float8 AS speed
       FROM location_point lp
       JOIN transport t ON t.id = lp.transport_id
      WHERE t.team_id = $1 AND t.status = ANY($2::transport_status[])
        AND lp.recorded_at > now() - make_interval(secs => $3)
      ORDER BY lp.recorded_at DESC LIMIT 1`,
    [teamId, ACTIVE, RECENT_SPEED_SECONDS],
  );
  return (rows[0]?.speed ?? 0) >= DRIVING_KMH;
}

export function draftRouter(
  ctx: AuthContext,
  guards: RequestHandler[],
  realtime?: Realtime,
): Router {
  const router = Router();
  const { pool } = ctx;

  router.get('/teams/current/draft', ...guards, async (_req, res) => {
    const me = await myMembership(pool, paramedicAuth(res).paramedicId);
    const { rows } = await pool.query<DraftRow>(
      'SELECT data, field_meta, version FROM team_draft WHERE team_id = $1',
      [me.team_id],
    );
    const prev = await prevPatientState(pool, me.team_id);
    // 10분이 지난 직전 환자 정보는 주기 작업이 1분 안에 비운다. 그 사이에 열어도 빈 입력으로 보인다 (SFR-157)
    const draft = prev?.expired ? undefined : rows[0];
    res.json({
      version: draft?.version ?? 0,
      assessment: draft?.data ?? {},
      fieldMeta: publicMeta(draft?.field_meta ?? {}),
      // 직전 이송이 끝난 뒤 아무도 안 고친 작성 중 정보 = 직전 환자 정보. 앱이 '직전 환자 정보 · 지우기'를 띄운다
      prefilledFromTransportId: prev && !prev.expired ? prev.transportId : null,
      prefillExpiresAt: prev && !prev.expired ? prev.expiresAt.toISOString() : null,
    });
  });

  router.patch('/teams/current/draft', ...guards, async (req, res) => {
    const input = parseBody(patchSchema, req.body);
    const { paramedicId } = paramedicAuth(res);

    const { body, events } = await withTransaction(pool, async (client) => {
      const me = await myMembership(client, paramedicId);
      if (me.role === 'driver' && (await isDriving(client, me.team_id, input.speedKmh))) {
        throw new AppError(403, 'DRIVER_INPUT_LOCKED', '주행 중에는 팀원이 입력해요');
      }

      // 10분 지난 직전 환자 정보 위에 새 환자 칸을 합치면 안 된다. 먼저 비운다 (SFR-157)
      const cleared = await clearExpiredPrevPatient(client, me.team_id);
      // 팀의 작성 중 정보 행을 잠근다: 두 팀원이 동시에 보내도 한 명씩 합쳐서 칸이 사라지지 않는다
      await client.query(
        'INSERT INTO team_draft (team_id, version) VALUES ($1, 0) ON CONFLICT (team_id) DO NOTHING',
        [me.team_id],
      );
      const { rows } = await client.query<DraftRow & { now: Date }>(
        'SELECT data, field_meta, version, now() AS now FROM team_draft WHERE team_id = $1 FOR UPDATE',
        [me.team_id],
      );
      const current = rows[0];
      const version = current.version + 1;
      const data: Data = { ...current.data };
      const meta = { ...current.field_meta };
      const overwritten: { field: string; prevByName: string }[] = [];

      for (const [field, value] of Object.entries(input.changes)) {
        const prev = meta[field];
        // 내가 마지막으로 받은 뒤에 다른 팀원이 고친 칸을 내가 덮어씀 → 화면에 알림
        if (prev && prev.version > input.baseVersion && prev.by !== paramedicId) {
          overwritten.push({ field, prevByName: prev.byName });
        }
        if (value === null) delete data[field];
        else data[field] = value;
        meta[field] = { by: paramedicId, byName: me.name, at: current.now.toISOString(), version };
      }

      await client.query(
        `UPDATE team_draft SET data = $2, field_meta = $3, version = $4, updated_by = $5, updated_at = now()
          WHERE team_id = $1`,
        [me.team_id, data, meta, version, paramedicId],
      );
      const logged = await appendEvents(client, [
        ...(cleared ? [cleared] : []),
        {
          room: `team:${me.team_id}`,
          name: 'draft.updated',
          entityType: 'team_draft',
          entityId: me.team_id,
          entityVersion: version,
          // 칸 이름·고친 사람·버전만. 값은 넣지 않는다 (규칙 5, SER-014)
          payload: {
            version,
            fields: Object.keys(input.changes),
            byName: me.name,
            overwritten,
          },
        },
      ]);
      return { body: { version, assessment: data, overwritten }, events: logged };
    });

    realtime?.publish(events);
    res.json(body);
  });

  // 작성 중 정보 비우기 (직전 환자 정보 지우기 SFR-157 도 이걸 쓴다)
  router.delete('/teams/current/draft', ...guards, async (_req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const events = await withTransaction(pool, async (client) => {
      const me = await myMembership(client, paramedicId);
      const { rowCount } = await client.query('DELETE FROM team_draft WHERE team_id = $1', [
        me.team_id,
      ]);
      if (!rowCount) return [];
      return appendEvents(client, [
        {
          room: `team:${me.team_id}`,
          name: 'draft.updated',
          entityType: 'team_draft',
          entityId: me.team_id,
          payload: { version: 0, fields: [], byName: me.name, overwritten: [] },
        },
      ]);
    });
    realtime?.publish(events);
    res.status(204).end();
  });

  return router;
}
