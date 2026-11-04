// 팀 맺기 (SFR-113): 팀 만들기·코드/QR 참여·내 팀 보기·역할 바꾸기·근무 종료.
// 팀 1개 = 구급차 1대. 최대 4명, 운전은 1명, 대원은 동시에 팀 1개 (DB 유니크 인덱스가 마지막으로 한 번 더 막는다).
// 14시간 자동 근무 종료 타이머와 team.member_joined 같은 실시간 이벤트는 S3 실시간 모듈이 생기면 붙인다.
import { randomBytes, randomInt } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { ACTIVE } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { forgetSessionState, type AuthContext } from '../auth/session.js';
import { endDuty } from './endDuty.js';

export const MAX_MEMBERS = 4;
// 4자리 코드는 1만 개뿐이라 활성 팀끼리 겹칠 수 있다. 겹치면 다시 뽑는다.
const CODE_ATTEMPTS = 20;

type Role = 'driver' | 'care';
const roleSchema = z.enum(['driver', 'care']);
const createSchema = z.object({ role: roleSchema });
const roleBody = z.object({ role: roleSchema });
// 코드와 QR 중 하나만 보낸다
const joinSchema = z.union([
  z.object({
    code: z.string().regex(/^\d{4}$/),
    qrToken: z.undefined().optional(),
    role: roleSchema,
  }),
  z.object({
    qrToken: z.string().min(1).max(100),
    code: z.undefined().optional(),
    role: roleSchema,
  }),
]);

const alreadyInTeam = () => new AppError(409, 'ALREADY_IN_TEAM', '이미 팀에 있어요');
const notInTeam = () => new AppError(404, 'NOT_IN_TEAM', '근무 중인 팀이 없어요');
const driverTaken = () => new AppError(409, 'DRIVER_TAKEN', "'운전'은 팀에 1명만 고를 수 있어요");

type Db = pg.Pool | pg.PoolClient;

export async function currentTeamId(db: Db, paramedicId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ team_id: string }>(
    'SELECT team_id FROM team_member WHERE paramedic_id = $1 AND left_at IS NULL',
    [paramedicId],
  );
  return rows[0]?.team_id;
}

// 같은 대원의 팀 만들기·참여를 한 줄로 세운다. 두 번 눌러도 팀이 2개 생기지 않는다.
async function lockMeOutsideTeam(client: pg.PoolClient, paramedicId: string): Promise<void> {
  await client.query('SELECT id FROM paramedic WHERE id = $1 FOR UPDATE', [paramedicId]);
  if (await currentTeamId(client, paramedicId)) throw alreadyInTeam();
}

async function hasDriver(client: pg.PoolClient, teamId: string, except?: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM team_member
      WHERE team_id = $1 AND left_at IS NULL AND role = 'driver' AND paramedic_id IS DISTINCT FROM $2`,
    [teamId, except ?? null],
  );
  return rows.length > 0;
}

async function addMember(client: pg.PoolClient, teamId: string, paramedicId: string, role: Role) {
  // joined_seq: 팀에 들어온 시점까지의 이벤트 번호. 그 전 팀 이벤트(환자 정보 등)는 이 대원에게 다시 보내지 않는다
  await client.query(
    `INSERT INTO team_member (team_id, paramedic_id, role, joined_seq)
     VALUES ($1, $2, $3, (SELECT coalesce(max(seq), 0) FROM event_log))`,
    [teamId, paramedicId, role],
  );
}

export async function loadTeam(db: Db, teamId: string, meId: string) {
  const { rows } = await db.query<{
    id: string;
    code: string;
    qr_token: string;
    paramedic_id: string;
    name: string;
    rank: string;
    role: Role;
  }>(
    `SELECT t.id, t.code, t.qr_token, m.paramedic_id, p.name, p.rank, m.role
       FROM team t
       JOIN team_member m ON m.team_id = t.id AND m.left_at IS NULL
       JOIN paramedic p ON p.id = m.paramedic_id
      WHERE t.id = $1
      ORDER BY m.joined_at`,
    [teamId],
  );
  return {
    id: Number(rows[0].id),
    code: rows[0].code,
    qrToken: rows[0].qr_token,
    members: rows.map((r) => ({
      paramedicId: Number(r.paramedic_id),
      name: r.name,
      rank: r.rank,
      role: r.role,
      isMe: r.paramedic_id === meId,
    })),
    maxMembers: MAX_MEMBERS,
  };
}

export function teamRouter(ctx: AuthContext, guards: RequestHandler[]): Router {
  const router = Router();

  router.post('/teams', ...guards, async (req, res) => {
    const { role } = parseBody(createSchema, req.body);
    const { paramedicId } = paramedicAuth(res);

    const team = await withTransaction(ctx.pool, async (client) => {
      await lockMeOutsideTeam(client, paramedicId);
      // ON CONFLICT DO NOTHING: 코드가 활성 팀과 겹치면 오류 대신 빈 결과가 와서 트랜잭션을 깨지 않고 다시 뽑을 수 있다
      for (let i = 0; i < CODE_ATTEMPTS; i += 1) {
        const code = String(randomInt(10000)).padStart(4, '0');
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO team (code, qr_token, created_by) VALUES ($1, $2, $3)
           ON CONFLICT (code) WHERE ended_at IS NULL DO NOTHING
           RETURNING id`,
          [code, randomBytes(24).toString('base64url'), paramedicId],
        );
        if (rows[0]) {
          await addMember(client, rows[0].id, paramedicId, role);
          return loadTeam(client, rows[0].id, paramedicId);
        }
      }
      throw new Error('남은 팀 코드를 찾지 못했어요');
    });
    res.status(201).json(team);
  });

  router.post('/teams/join', ...guards, async (req, res) => {
    const input = parseBody(joinSchema, req.body);
    const { paramedicId } = paramedicAuth(res);

    const team = await withTransaction(ctx.pool, async (client) => {
      await lockMeOutsideTeam(client, paramedicId);
      // 팀 행을 잠가 같은 팀 참여를 한 줄로 세운다. 인원 세기와 넣기 사이에 다른 사람이 끼어들어 5명이 되지 않는다.
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM team
          WHERE ${input.code !== undefined ? 'code' : 'qr_token'} = $1 AND ended_at IS NULL
          FOR UPDATE`,
        [input.code ?? input.qrToken],
      );
      const teamId = rows[0]?.id;
      if (!teamId) throw new AppError(404, 'TEAM_NOT_FOUND', '팀을 찾을 수 없어요');

      const { rows: count } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM team_member WHERE team_id = $1 AND left_at IS NULL',
        [teamId],
      );
      if (count[0].n >= MAX_MEMBERS) {
        throw new AppError(409, 'TEAM_FULL', `팀 인원이 가득 찼어요(최대 ${MAX_MEMBERS}명)`);
      }
      if (input.role === 'driver' && (await hasDriver(client, teamId))) throw driverTaken();

      await addMember(client, teamId, paramedicId, input.role);
      return loadTeam(client, teamId, paramedicId);
    });
    res.json(team);
  });

  router.get('/teams/current', ...guards, async (_req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const teamId = await currentTeamId(ctx.pool, paramedicId);
    if (!teamId) throw notInTeam();
    res.json(await loadTeam(ctx.pool, teamId, paramedicId));
  });

  router.patch('/teams/current/members/me', ...guards, async (req, res) => {
    const { role } = parseBody(roleBody, req.body);
    const { paramedicId } = paramedicAuth(res);

    const team = await withTransaction(ctx.pool, async (client) => {
      const teamId = await currentTeamId(client, paramedicId);
      if (!teamId) throw notInTeam();
      await client.query('SELECT id FROM team WHERE id = $1 FOR UPDATE', [teamId]);

      // 이송 중에는 경로 안내 담당 단말 등이 역할에 묶여 있어 바꾸지 않는다
      const { rows: active } = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM transport WHERE team_id = $1 AND status = ANY($2::transport_status[])',
        [teamId, ACTIVE],
      );
      if (active[0]) {
        throw new AppError(
          409,
          'ACTIVE_TRANSPORT_EXISTS',
          '진행 중 이송이 끝난 뒤 바꿀 수 있어요',
          {
            activeTransport: { id: active[0].id, status: active[0].status },
          },
        );
      }
      if (role === 'driver' && (await hasDriver(client, teamId, paramedicId))) throw driverTaken();

      await client.query(
        'UPDATE team_member SET role = $3 WHERE team_id = $1 AND paramedic_id = $2 AND left_at IS NULL',
        [teamId, paramedicId, role],
      );
      return loadTeam(client, teamId, paramedicId);
    });
    res.json(team);
  });

  // 근무 종료 = 로그아웃과 같다 (SFR-113). 나만 팀에서 빠지고, 마지막 1명이면 진행 중 이송을 취소하고 팀을 닫는다.
  router.post('/teams/current/leave', ...guards, async (req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const confirmCancelActive = req.query.confirmCancelActive === 'true';
    await withTransaction(ctx.pool, async (client) => {
      const result = await endDuty(client, ctx, paramedicId, 'duty_end', confirmCancelActive);
      // 팀이 없으면 아무것도 바꾸지 않고 돌려보낸다 (롤백되어 로그인도 그대로)
      if (result.teamId === null) throw notInTeam();
    });
    await forgetSessionState(ctx, paramedicId);
    res.status(204).end();
  });

  return router;
}
