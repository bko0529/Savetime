// 경로 안내 담당 단말 (SFR-132·133). 위치 기록과 도착 버튼은 이 단말 1대에서만 동작한다.
// - 병원을 확정하면: 팀에 '운전' 역할이 없거나 확정한 사람이 운전자면 확정한 대원 단말이 바로 담당
// - 운전자가 따로 있으면: 운전 단말이 확정 후 10초 안에 POST /nav-device 로 응답하면 그 단말이 담당.
//   10초가 지나도 응답이 없으면(폰 꺼짐 등) 10초 작업이 확정한 대원 단말(nav_fallback_device_id)로 넘긴다.
//   늦게 응답한 운전 단말은 보기 전용 (NAV_DEVICE_ASSIGNED)
// - 대원의 단말 = 지금 로그인한 단말(살아 있는 최신 refresh_token.device_id). 근무 1명당 로그인 1대다
// - 10초 판정은 DB now() (절대 규칙 6), 담당은 DB 칸에 (규칙 7). 담당을 정하면 이송 건 version +1 (SFR-160)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { ACTIVE } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { lockMyTransport, transportIdParam } from './access.js';
import { loadTransport } from './view.js';

export const NAV_WAIT_SECONDS = 10;

type Db = pg.Pool | pg.PoolClient;

// 대원이 지금 로그인한 단말
export async function currentDeviceOf(db: Db, paramedicId: string): Promise<string | null> {
  const { rows } = await db.query<{ device_id: string }>(
    `SELECT device_id FROM refresh_token
      WHERE owner_type = 'paramedic' AND owner_id = $1 AND revoked_at IS NULL AND expires_at > now()
        AND device_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [paramedicId],
  );
  return rows[0]?.device_id ?? null;
}

// 팀의 운전 역할 대원 (없으면 null)
async function driverOf(db: Db, teamId: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT p.id, p.name FROM team_member m JOIN paramedic p ON p.id = m.paramedic_id
      WHERE m.team_id = $1 AND m.left_at IS NULL AND m.role = 'driver'
      ORDER BY m.joined_at LIMIT 1`,
    [teamId],
  );
  return rows[0] ?? null;
}

// 단말 주인 이름 (팀원 화면 'OOO 님 단말에서 경로 안내 중')
async function ownerName(db: Db, teamId: string, deviceId: string): Promise<string | null> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT p.name FROM team_member m
       JOIN paramedic p ON p.id = m.paramedic_id
       JOIN refresh_token t ON t.owner_type = 'paramedic' AND t.owner_id = p.id
      WHERE m.team_id = $1 AND m.left_at IS NULL AND t.device_id = $2
      ORDER BY t.created_at DESC LIMIT 1`,
    [teamId, deviceId],
  );
  return rows[0]?.name ?? null;
}

function navEvent(
  teamId: string,
  transportId: string,
  version: number,
  navDeviceId: string,
  byName: string | null,
): EventRecord {
  return {
    room: `team:${teamId}`,
    name: 'transport.nav_device',
    entityType: 'transport',
    entityId: transportId,
    entityVersion: version,
    // 단말 ID·주인 이름만 (규칙 5)
    payload: { transportId, navDeviceId, byName: byName ?? '' },
  };
}

export interface NavOnConfirm {
  navDeviceId: string | null; // 바로 정해졌으면 그 단말
  pending: boolean; // 운전 단말 응답을 10초 기다림 → 커밋 뒤 10초 작업을 건다
}

// 병원 확정(확정 API·전화 확인 수용) 트랜잭션 안, 이송 건 행을 '이동 중'으로 바꾸는 UPDATE 직전에 부른다.
// 정한 값은 같은 UPDATE 에 넣도록 돌려준다 (version 이 한 번만 오른다)
export async function navOnConfirm(
  client: pg.PoolClient,
  input: { transportId: string; teamId: string; paramedicId: string },
): Promise<NavOnConfirm> {
  const { rows } = await client.query<{ nav_device_id: string | null }>(
    'SELECT nav_device_id FROM transport WHERE id = $1',
    [input.transportId],
  );
  // 목적지 변경·다시 요청 뒤 다시 확정: 경로 안내는 그대로 이어 간다 (SFR-077·128)
  if (rows[0].nav_device_id) return { navDeviceId: rows[0].nav_device_id, pending: false };

  const mine = await currentDeviceOf(client, input.paramedicId);
  const driver = await driverOf(client, input.teamId);
  // 운전 역할이 없거나 내가 운전자: 확정한 단말에서 바로 시작
  if (!driver || driver.id === input.paramedicId) return { navDeviceId: mine, pending: false };
  // 운전자가 따로 있다: 운전 단말 응답을 10초 기다린다. 없으면 확정한 대원 단말로 넘긴다
  await client.query('UPDATE transport SET nav_fallback_device_id = $2 WHERE id = $1', [
    input.transportId,
    mine,
  ]);
  return { navDeviceId: null, pending: true };
}

// 10초가 지났는데 아직 담당이 없으면 확정한 대원 단말로 넘긴다. 이송 건 행이 잠긴 트랜잭션에서 부른다.
// 'not_due' = 아직 10초 전, null = 할 일 없음
export async function fallbackIfDue(
  client: pg.PoolClient,
  transportId: string,
): Promise<'not_due' | EventRecord[] | null> {
  const { rows } = await client.query<{
    team_id: string | null;
    status: string;
    nav_device_id: string | null;
    nav_fallback_device_id: string | null;
    due: boolean;
  }>(
    `SELECT team_id, status, nav_device_id, nav_fallback_device_id,
            confirmed_at + make_interval(secs => $2) <= now() AS due
       FROM transport WHERE id = $1`,
    [transportId, NAV_WAIT_SECONDS],
  );
  const t = rows[0];
  if (!t || !t.team_id || !ACTIVE.includes(t.status as never)) return null;
  if (t.nav_device_id || !t.nav_fallback_device_id) return null;
  if (!t.due) return 'not_due';
  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE transport SET nav_device_id = nav_fallback_device_id, nav_fallback_device_id = NULL,
            version = version + 1
      WHERE id = $1 RETURNING version`,
    [transportId],
  );
  const name = await ownerName(client, t.team_id, t.nav_fallback_device_id);
  return [navEvent(t.team_id, transportId, updated[0].version, t.nav_fallback_device_id, name)];
}

// 10초 작업 본체: 잠그고 넘긴다. 커밋 뒤 보낼 이벤트를 돌려준다
export async function runNavFallback(
  pool: pg.Pool,
  transportId: string,
): Promise<'not_due' | LoggedEvent[]> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT 1 FROM transport WHERE id = $1 FOR UPDATE', [transportId]);
    const result = await fallbackIfDue(client, transportId);
    if (result === 'not_due') return 'not_due';
    return result ? appendEvents(client, result) : [];
  });
}

// 확정 이벤트 뒤에 붙일 '담당 단말 정해짐' (바로 정해진 경우)
export async function navAssignedEvent(
  client: pg.PoolClient,
  input: { transportId: string; teamId: string; version: number; navDeviceId: string },
): Promise<EventRecord> {
  const name = await ownerName(client, input.teamId, input.navDeviceId);
  return navEvent(input.teamId, input.transportId, input.version, input.navDeviceId, name);
}

const claimSchema = z.object({
  deviceId: z.string().min(1).max(80),
  version: z.number().int().optional(),
});

export function navDeviceRouter(
  pool: pg.Pool,
  guards: RequestHandler[],
  realtime?: Realtime,
): Router {
  const router = Router();
  router.post('/transports/:transportId/nav-device', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const input = parseBody(claimSchema, req.body);
    const { paramedicId } = paramedicAuth(res);

    const { navDeviceId } = await withTransaction(pool, async (client) => {
      const transport = await lockMyTransport(client, transportId, paramedicId);
      // 남의 단말 ID 로 담당을 가져가지 못하게: 지금 로그인한 내 단말이어야 한다
      if ((await currentDeviceOf(client, paramedicId)) !== input.deviceId) {
        throw new AppError(400, 'VALIDATION_FAILED', '이 단말로 로그인한 대원이 아니에요', {
          fields: ['deviceId'],
        });
      }
      const { rows } = await client.query<{
        nav_device_id: string | null;
        departed_at: Date | null;
      }>('SELECT nav_device_id, departed_at FROM transport WHERE id = $1', [transportId]);
      if (!rows[0].departed_at || !ACTIVE.includes(transport.status)) {
        throw new AppError(409, 'INVALID_TRANSITION', '경로 안내 중인 이송이 아니에요', {
          current: await loadTransport(client, transportId, paramedicId),
        });
      }

      // 10초가 지났으면 먼저 확정한 대원 단말로 넘긴다 (작업보다 먼저 와도 결과가 같게)
      const fell = await fallbackIfDue(client, transportId);
      const logged = Array.isArray(fell) ? await appendEvents(client, fell) : [];
      const { rows: now } = await client.query<{ nav_device_id: string | null; version: number }>(
        'SELECT nav_device_id, version FROM transport WHERE id = $1',
        [transportId],
      );
      const current = now[0].nav_device_id;
      if (current) {
        if (current === input.deviceId) return { navDeviceId: current, events: logged };
        // 이미 다른 단말이 담당: 보기 전용. 커밋은 해야 하니(넘김 기록) 던지지 않고 표시만 한다
        return { navDeviceId: current, events: logged, assignedToOther: true };
      }

      // 아직 기다리는 중(10초 안): 운전 역할 대원만 가져갈 수 있다
      const driver = await driverOf(client, transport.team_id);
      if (driver?.id !== paramedicId) {
        throw new AppError(403, 'NOT_NAV_DEVICE', '운전 단말이 응답하기를 기다리는 중이에요');
      }
      if (input.version === undefined) {
        throw new AppError(400, 'VERSION_REQUIRED', 'version을 같이 보내야 해요');
      }
      if (input.version !== now[0].version) {
        throw new AppError(409, 'VERSION_CONFLICT', '그사이 상태가 바뀌었어요', {
          current: await loadTransport(client, transportId, paramedicId),
        });
      }
      const { rows: updated } = await client.query<{ version: number }>(
        `UPDATE transport SET nav_device_id = $2, nav_fallback_device_id = NULL, version = version + 1
          WHERE id = $1 RETURNING version`,
        [transportId, input.deviceId],
      );
      const event = navEvent(
        transport.team_id,
        transportId,
        updated[0].version,
        input.deviceId,
        driver.name,
      );
      return { navDeviceId: input.deviceId, events: await appendEvents(client, [event]) };
    }).then((r) => {
      // 커밋된 뒤: 넘김 이벤트는 보내고, 다른 단말이 담당이면 409 로 알린다
      realtime?.publish(r.events);
      if ('assignedToOther' in r) {
        throw new AppError(
          409,
          'NAV_DEVICE_ASSIGNED',
          '다른 단말에서 경로 안내 중이에요 (보기 전용)',
          {
            navDeviceId: r.navDeviceId,
          },
        );
      }
      return r;
    });

    res.json({ navDeviceId, isMe: navDeviceId === input.deviceId });
  });
  return router;
}
