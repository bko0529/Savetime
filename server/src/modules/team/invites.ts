// 팀원 목록 초대 (SFR-159): 같은 소방서 근무 중 대원 목록·이름 검색 → 초대 → 수락(역할 선택)·거절·5분 만료.
// - "근무 중" = 로그인해 있음. 이 시스템은 로그인이 곧 근무 시작이라(SFR-018) 살아 있는 갱신 토큰이 있으면 근무 중이다
// - 초대 만료 5분은 DB now() 로 정하고(규칙 6) BullMQ 지연 작업이 만료 처리한다. 서버가 재시작하면 DB 에서 다시 건다(규칙 7)
// - 잠그는 순서는 항상 초대 → 대원 → 팀. 팀 만들기·코드 참여(routes.ts)도 대원 → 팀 순서라 서로 기다리다 멈추지 않는다
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import type { AuthContext } from '../auth/session.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import {
  addMember,
  currentTeamId,
  hasDriver,
  loadTeam,
  MAX_MEMBERS,
  memberJoinedEvent,
} from './routes.js';

const INVITE_MINUTES = 5;
const DEFAULT_LIMIT = 30;

const sendSchema = z.object({ toParamedicId: z.coerce.number().int().positive() });
const acceptSchema = z.object({ role: z.enum(['driver', 'care']) });
const listQuery = z.object({
  q: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_LIMIT),
  cursor: z.string().max(200).optional(),
});
// 커서 = 마지막으로 본 줄의 정렬 값 [근무 중이면 0·아니면 1, 이름, id]. 그 다음 줄부터 가져온다
const cursorSchema = z.tuple([z.union([z.literal(0), z.literal(1)]), z.string(), z.number()]);

const notFound = () => new AppError(404, 'NOT_FOUND', '초대를 찾을 수 없어요');
const notInTeam = () => new AppError(404, 'NOT_IN_TEAM', '근무 중인 팀이 없어요');
const inviteExpired = () => new AppError(409, 'INVITE_EXPIRED', '초대가 만료됐어요');
const teamFull = () =>
  new AppError(409, 'TEAM_FULL', `팀 인원이 가득 찼어요(최대 ${MAX_MEMBERS}명)`);

function badCursor(): never {
  throw new AppError(400, 'VALIDATION_FAILED', '목록 위치(cursor)가 맞지 않아요', {
    fields: ['cursor'],
  });
}

function encodeCursor(value: [0 | 1, string, number]): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string): [0 | 1, string, number] {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return parsed.success ? parsed.data : badCursor();
  } catch {
    return badCursor();
  }
}

// LIKE 에서 % _ \ 를 글자 그대로 찾게 한다 (이름에 %를 넣어 전체를 뒤지지 못하게)
const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

async function memberCount(client: pg.PoolClient, teamId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM team_member WHERE team_id = $1 AND left_at IS NULL',
    [teamId],
  );
  return rows[0].n;
}

interface InviteRow {
  id: string;
  team_id: string;
  from_id: string;
  to_id: string;
  status: 'sent' | 'accepted' | 'declined' | 'expired';
  due: boolean; // 5분이 지났는지 (DB now() 기준)
  to_name: string;
}

// 초대 행을 잠그고 읽는다. toId 를 주면 나에게 온 초대만 (남의 초대는 404 로 숨김, SER-010)
async function lockInvite(
  client: pg.PoolClient,
  inviteId: string,
  toId?: string,
): Promise<InviteRow | undefined> {
  const { rows } = await client.query<InviteRow>(
    `SELECT i.id, i.team_id, i.from_id, i.to_id, i.status, i.expires_at <= now() AS due, p.name AS to_name
       FROM team_invite i JOIN paramedic p ON p.id = i.to_id
      WHERE i.id = $1 AND ($2::bigint IS NULL OR i.to_id = $2)
      FOR UPDATE OF i`,
    [inviteId, toId ?? null],
  );
  return rows[0];
}

const resultEvent = (
  invite: InviteRow,
  result: 'accepted' | 'declined' | 'expired',
): EventRecord => ({
  room: `paramedic:${invite.from_id}`,
  name: 'team.invite_result',
  entityType: 'team_invite',
  entityId: invite.id,
  payload: { inviteId: Number(invite.id), toName: invite.to_name, result },
});

// 5분 만료 (BullMQ 작업이 부른다). 이미 수락·거절됐으면 아무것도 안 한다(멱등). 일찍 깨어났으면 'not_due'
export async function expireInvite(
  pool: pg.Pool,
  inviteId: string,
): Promise<LoggedEvent[] | 'not_due' | null> {
  return withTransaction(pool, async (client) => {
    const invite = await lockInvite(client, inviteId);
    if (!invite || invite.status !== 'sent') return null;
    if (!invite.due) return 'not_due';
    await client.query("UPDATE team_invite SET status = 'expired' WHERE id = $1", [invite.id]);
    return appendEvents(client, [resultEvent(invite, 'expired')]);
  });
}

export function inviteRouter(
  ctx: AuthContext,
  guards: RequestHandler[],
  realtime?: Realtime,
): Router {
  const router = Router();
  const { pool } = ctx;

  // 같은 소방서 대원 목록. q 가 없으면 근무 중인 대원만, 있으면 소방서 전체에서 이름으로 찾는다
  router.get('/paramedics/on-duty', ...guards, async (req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const input = listQuery.safeParse(req.query);
    if (!input.success) {
      throw new AppError(400, 'VALIDATION_FAILED', '입력 형식이 맞지 않아요', {
        fields: [...new Set(input.error.issues.map((i) => i.path.join('.')))],
      });
    }
    const { limit } = input.data;
    const q = input.data.q || undefined;
    const after = input.data.cursor ? decodeCursor(input.data.cursor) : null;

    // 승인된 대원만 (승인 전·정지·탈퇴는 빠짐). 사번은 뒤 4자리만 내보낸다 (동명이인 구분용)
    const { rows } = await pool.query<{
      id: string;
      name: string;
      rank: string;
      safety_center: string;
      tail: string;
      on_duty: boolean;
      in_team: boolean;
      memo: string | null;
      invite_status: 'none' | 'sent' | 'accepted';
    }>(
      `WITH me AS (
         SELECT p.agency_id,
                (SELECT team_id FROM team_member WHERE paramedic_id = p.id AND left_at IS NULL) AS team_id
           FROM paramedic p WHERE p.id = $1
       ), list AS (
         SELECT p.id, p.name, p.rank, p.safety_center, right(p.employee_no, 4) AS tail,
                EXISTS (SELECT 1 FROM refresh_token r
                         WHERE r.owner_type = 'paramedic' AND r.owner_id = p.id
                           AND r.revoked_at IS NULL AND r.expires_at > now()) AS on_duty,
                m.team_id AS their_team
           FROM paramedic p
           CROSS JOIN me
           LEFT JOIN team_member m ON m.paramedic_id = p.id AND m.left_at IS NULL
          WHERE p.agency_id = me.agency_id AND p.status = 'approved' AND p.id <> $1
       )
       SELECT l.id, l.name, l.rank, l.safety_center, l.tail, l.on_duty,
              l.their_team IS NOT NULL AS in_team,
              memo.memo,
              CASE
                WHEN me.team_id IS NOT NULL AND l.their_team = me.team_id THEN 'accepted'
                WHEN EXISTS (SELECT 1 FROM team_invite i
                              WHERE i.team_id = me.team_id AND i.to_id = l.id
                                AND i.status = 'sent' AND i.expires_at > now()) THEN 'sent'
                ELSE 'none'
              END AS invite_status
         FROM list l
         CROSS JOIN me
         LEFT JOIN paramedic_memo memo ON memo.owner_id = $1 AND memo.target_id = l.id
        WHERE ($2::text IS NULL AND l.on_duty OR $2::text IS NOT NULL AND l.name LIKE '%' || $2 || '%')
          AND ($3::int IS NULL OR (CASE WHEN l.on_duty THEN 0 ELSE 1 END, l.name, l.id) > ($3, $4::text, $5::bigint))
        ORDER BY CASE WHEN l.on_duty THEN 0 ELSE 1 END, l.name, l.id
        LIMIT $6`,
      [
        paramedicId,
        q === undefined ? null : likeEscape(q),
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        limit + 1, // 1줄 더 읽어서 다음 페이지가 있는지 본다
      ],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      items: page.map((r) => ({
        paramedicId: Number(r.id),
        name: r.name,
        rank: r.rank,
        safetyCenter: r.safety_center,
        employeeNoTail: r.tail,
        myMemo: r.memo,
        onDuty: r.on_duty,
        inTeam: r.in_team,
        inviteStatus: r.invite_status,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor([last.on_duty ? 0 : 1, last.name, Number(last.id)])
          : null,
    });
  });

  // 초대 보내기. 받는 사람에게 team.invited + 푸시, 5분 만료 타이머
  router.post('/teams/current/invites', ...guards, async (req, res) => {
    const { toParamedicId } = parseBody(sendSchema, req.body);
    const { paramedicId } = paramedicAuth(res);

    const { invite, events, created } = await withTransaction(pool, async (client) => {
      const teamId = await currentTeamId(client, paramedicId);
      if (!teamId) throw notInTeam();

      // 받는 사람 행을 잠근다: 그 사람이 동시에 다른 팀에 들어가는 것과 한 줄로 선다 (대원 → 팀 순서)
      const { rows: target } = await client.query<{ id: string }>(
        `SELECT t.id FROM paramedic t
          WHERE t.id = $1 AND t.id <> $2 AND t.status = 'approved'
            AND t.agency_id = (SELECT agency_id FROM paramedic WHERE id = $2)
          FOR UPDATE`,
        [toParamedicId, paramedicId],
      );
      // 다른 소방서·승인 전 대원은 있는지조차 알려주지 않는다
      if (!target[0]) throw new AppError(404, 'NOT_FOUND', '초대할 대원을 찾을 수 없어요');
      if (await currentTeamId(client, target[0].id)) {
        throw new AppError(409, 'TARGET_IN_TEAM', '이미 다른 팀에 있어요');
      }
      const { rows: team } = await client.query<{ code: string }>(
        'SELECT code FROM team WHERE id = $1 FOR UPDATE',
        [teamId],
      );
      if ((await memberCount(client, teamId)) >= MAX_MEMBERS) throw teamFull();

      // 아직 살아 있는 같은 초대가 있으면 그것을 돌려준다 (두 번 눌러도 1건, 알림도 1번)
      const { rows: open } = await client.query<{ id: string; expires_at: Date }>(
        `SELECT id, expires_at FROM team_invite
          WHERE team_id = $1 AND to_id = $2 AND status = 'sent' AND expires_at > now()`,
        [teamId, target[0].id],
      );
      if (open[0]) return { invite: open[0], events: [], created: false };

      const { rows: inserted } = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO team_invite (team_id, from_id, to_id, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4))
         RETURNING id, expires_at`,
        [teamId, paramedicId, target[0].id, INVITE_MINUTES],
      );
      const { rows: from } = await client.query<{ name: string }>(
        'SELECT name FROM paramedic WHERE id = $1',
        [paramedicId],
      );
      const logged = await appendEvents(client, [
        {
          room: `paramedic:${target[0].id}`,
          name: 'team.invited',
          entityType: 'team_invite',
          entityId: inserted[0].id,
          // 초대 카드에 "김도윤 님이 초대했어요"를 보여 주려고 보낸 사람 이름을 넣는다 (환자 정보 아님)
          payload: {
            inviteId: Number(inserted[0].id),
            teamCode: team[0].code,
            fromName: from[0].name,
            expiresAt: inserted[0].expires_at.toISOString(),
          },
        },
      ]);
      return { invite: inserted[0], events: logged, created: true };
    });

    realtime?.publish(events);
    if (created) realtime?.scheduleInviteExpiry(invite.id);
    res
      .status(201)
      .json({ inviteId: Number(invite.id), expiresAt: invite.expires_at.toISOString() });
  });

  // 수락: 역할을 골라 그 팀에 들어간다
  router.post('/invites/:inviteId/accept', ...guards, async (req, res) => {
    const { role } = parseBody(acceptSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    const inviteId = String(req.params.inviteId);
    if (!/^\d{1,18}$/.test(inviteId)) throw notFound();

    const { team, events } = await withTransaction(pool, async (client) => {
      const invite = await lockInvite(client, inviteId, paramedicId);
      if (!invite) throw notFound();
      if (invite.status !== 'sent' || invite.due) throw inviteExpired();

      // 대원 → 팀 순서로 잠근다. 동시에 수락한 사람이 있어도 인원 세기와 넣기가 한 줄로 선다
      await client.query('SELECT id FROM paramedic WHERE id = $1 FOR UPDATE', [paramedicId]);
      if (await currentTeamId(client, paramedicId)) {
        throw new AppError(409, 'ALREADY_IN_TEAM', '이미 팀에 있어요');
      }
      const { rows: teamRow } = await client.query<{ ended: boolean }>(
        'SELECT ended_at IS NOT NULL AS ended FROM team WHERE id = $1 FOR UPDATE',
        [invite.team_id],
      );
      // 그 사이 팀이 닫혔으면(모두 근무 종료) 초대도 끝난 것으로 본다
      if (teamRow[0].ended) throw inviteExpired();
      if ((await memberCount(client, invite.team_id)) >= MAX_MEMBERS) throw teamFull();
      if (role === 'driver' && (await hasDriver(client, invite.team_id))) {
        throw new AppError(409, 'DRIVER_TAKEN', "'운전'은 팀에 1명만 고를 수 있어요");
      }

      await addMember(client, invite.team_id, paramedicId, role);
      await client.query("UPDATE team_invite SET status = 'accepted' WHERE id = $1", [invite.id]);
      const logged = await appendEvents(client, [
        resultEvent(invite, 'accepted'),
        memberJoinedEvent(invite.team_id, paramedicId, invite.to_name, role),
      ]);
      return { team: await loadTeam(client, invite.team_id, paramedicId), events: logged };
    });

    await realtime?.joinTeam(paramedicId, String(team.id));
    realtime?.publish(events);
    res.json(team);
  });

  router.post('/invites/:inviteId/decline', ...guards, async (req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const inviteId = String(req.params.inviteId);
    if (!/^\d{1,18}$/.test(inviteId)) throw notFound();

    const events = await withTransaction(pool, async (client) => {
      const invite = await lockInvite(client, inviteId, paramedicId);
      if (!invite) throw notFound();
      if (invite.status !== 'sent' || invite.due) throw inviteExpired();
      await client.query("UPDATE team_invite SET status = 'declined' WHERE id = $1", [invite.id]);
      return appendEvents(client, [resultEvent(invite, 'declined')]);
    });
    realtime?.publish(events);
    res.status(204).end();
  });

  return router;
}
