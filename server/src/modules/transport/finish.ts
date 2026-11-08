// 이송 끝내기: 대원의 이송 취소 (SFR-076, 부록 A24) · 수동 도착 (SFR-080, 부록 A19, A-2 46).
// 상태 변경은 stateMachine.ts 전이 함수만 거치고 (절대 규칙 4), 커밋된 뒤에만 실시간으로 알린다.
// 도착·취소하면 위치 기록을 익명 경로로 옮기고 원본을 지운다 (route.ts, SFR-039·041). 위치 기록이 없으면 이동 거리는 null.
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import {
  CASCADE,
  TARGET_STATES,
  transitionHreq,
  transitionTransport,
  type ArrivalMethod,
  type HreqStatus,
} from '../../domain/stateMachine.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { lockMyTransport, transportIdParam, withCurrentOnBlock } from './access.js';
import { cancelTransport } from './cancel.js';
import { closeRoute } from './route.js';
import { loadTransport } from './view.js';

// version이 빠지면 상태 전이 함수가 VERSION_REQUIRED로 거절한다 (SFR-160)
// 미이송 사유는 구급활동일지 칸을 채우려고 받는다 (SFR-164). 고르지 않아도 취소된다
const cancelSchema = z
  .object({
    version: z.number().int().optional(),
    notTransportedReason: z
      .enum(['refused', 'death', 'on_scene', 'other_agency', 'etc'])
      .optional(),
    notTransportedText: z.string().trim().min(1).max(30).optional(),
  })
  // '기타' 글은 기타를 골랐을 때만
  .refine((v) => v.notTransportedText === undefined || v.notTransportedReason === 'etc', {
    path: ['notTransportedText'],
  });
const arriveSchema = z.object({
  // hospital = 병원 '도착 확인' 요청에 대원이 '도착 처리'를 누름 (SFR-144, S5)
  method: z.enum(['button', 'menu', 'hospital']),
  version: z.number().int().optional(),
});

async function paramedicName(client: pg.PoolClient, paramedicId: string): Promise<string> {
  const { rows } = await client.query<{ name: string }>(
    'SELECT name FROM paramedic WHERE id = $1',
    [paramedicId],
  );
  return rows[0].name;
}

export interface ArriveInput {
  transportId: string;
  paramedicId: string;
  method: Exclude<ArrivalMethod, 'finish_previous'>;
  clientVersion: number | undefined;
}

export async function arriveTransport(client: pg.PoolClient, input: ArriveInput) {
  const { transportId } = input;
  const transport = await lockMyTransport(client, transportId, input.paramedicId);
  const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
  const now = clock[0].now;

  // '이동 중'에서만. 거리와 상관없이 끝낸다 (SFR-080)
  const { to, history } = transitionTransport(transport.status, 'ARRIVE', {
    now,
    version: transport.version,
    clientVersion: input.clientVersion,
    arrivalMethod: input.method,
  });

  // 이송이 끝나면 원본 출발 좌표를 지운다 (SER-002)
  const { rows: moved } = await client.query<{
    version: number;
    arrived_at: Date;
    departed_at: Date | null;
  }>(
    `UPDATE transport
        SET status = $2, arrived_at = now(), arrival_method = $3, version = version + 1,
            last_activity_at = now(), origin_lat = NULL, origin_lng = NULL
      WHERE id = $1
     RETURNING version, arrived_at, departed_at`,
    [transportId, to, input.method],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );

  const events: EventRecord[] = [];
  // 연쇄: 확정 병원 요청 → 도착. 병원의 환자 정보 열람 1시간이 이 시각부터 (부록 A-2 46, SER-014)
  for (const { target, event } of CASCADE.ARRIVE ?? []) {
    const { rows: requests } = await client.query<{
      id: string;
      hospital_id: string;
      status: HreqStatus;
      version: number;
    }>(
      `SELECT hr.id, hr.hospital_id, hr.status, hr.version
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $1 AND hr.status = ANY($2::hreq_status[])
        ORDER BY hr.id FOR UPDATE OF hr`,
      [transportId, TARGET_STATES[target as keyof typeof TARGET_STATES]],
    );
    for (const request of requests) {
      const result = transitionHreq(request.status, event, { now, version: request.version });
      const { rows: arrived } = await client.query<{ version: number }>(
        `UPDATE hospital_request SET status = $2, arrived_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [request.id, result.to],
      );
      events.push(
        {
          room: `hospital:${request.hospital_id}`,
          name: 'request.changed',
          entityType: 'hospital_request',
          entityId: request.id,
          entityVersion: arrived[0].version,
          payload: {
            requestId: Number(request.id),
            status: result.to,
            closeReason: null,
            byName: null,
            pcName: null,
          },
        },
        {
          room: `hospital:${request.hospital_id}`,
          name: 'incoming.arrived',
          entityType: 'hospital_request',
          entityId: request.id,
          payload: {
            requestId: Number(request.id),
            arrivedAt: moved[0].arrived_at.toISOString(),
            method: input.method,
          },
        },
      );
    }
  }

  // 위치 기록 → 익명 경로, 원본 삭제, 이송 건에는 이동 거리만 (SFR-039·041)
  const route = await closeRoute(client, transportId, { cancelled: false });

  const { arrived_at: arrivedAt, departed_at: departedAt } = moved[0];
  const durationSec =
    departedAt === null ? null : Math.round((arrivedAt.getTime() - departedAt.getTime()) / 1000);
  events.push({
    room: `team:${transport.team_id}`,
    name: 'transport.arrived',
    entityType: 'transport',
    entityId: transportId,
    entityVersion: moved[0].version,
    payload: { transportId, method: input.method, durationSec },
  });

  return {
    body: {
      arrivedAt,
      departedAt,
      distanceKm: route ? Math.round(route.distanceM / 100) / 10 : null,
      durationSec,
    },
    events: await appendEvents(client, events),
  };
}

export function finishRouter(pool: pg.Pool, guards: RequestHandler[], realtime?: Realtime): Router {
  const router = Router();

  // 이송 취소: 진행 중 4상태 모두에서, 사유 user (SFR-076) + 대원이 고른 미이송 사유 (SFR-164)
  router.post('/transports/:transportId/cancel', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const { version, notTransportedReason, notTransportedText } = parseBody(cancelSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    const outcome = await withCurrentOnBlock(pool, transportId, paramedicId, () =>
      withTransaction(pool, async (client) => {
        await lockMyTransport(client, transportId, paramedicId);
        const name = await paramedicName(client, paramedicId);
        const { events } = await cancelTransport(client, transportId, 'user', version, name);
        // 같은 트랜잭션에서 사유만 덧붙인다 (상태는 위 전이 함수가 이미 바꿈, 버전은 그대로)
        if (notTransportedReason) {
          await client.query(
            `UPDATE transport SET not_transported_reason = $2, not_transported_text = $3 WHERE id = $1`,
            [transportId, notTransportedReason, notTransportedText ?? null],
          );
        }
        return { body: await loadTransport(client, transportId, paramedicId), events };
      }),
    );
    realtime?.publish(outcome.events);
    res.json(outcome.body);
  });

  // 수동 도착: 메뉴의 '도착'·도착 버튼 (SFR-080·038)
  router.post('/transports/:transportId/arrive', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const input = parseBody(arriveSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    const outcome: { body: unknown; events: LoggedEvent[] } = await withCurrentOnBlock(
      pool,
      transportId,
      paramedicId,
      () =>
        withTransaction(pool, (client) =>
          arriveTransport(client, {
            transportId,
            paramedicId,
            method: input.method,
            clientVersion: input.version,
          }),
        ),
    );
    realtime?.publish(outcome.events);
    res.json(outcome.body);
  });

  return router;
}
