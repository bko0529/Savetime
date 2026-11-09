// 예비 흐름 전화 확인 (SFR-032 시작, SFR-034 결과 기록, 부록 A13·A14·A15). 상태 변경은 stateMachine.ts만 거친다 (절대 규칙 4).
// - 시작: 요청 중·예비 추천 → 전화 확인. 대상 병원을 기록하고, 요청 중이었으면 병원 요청은 열어 둔다 (D-127)
// - 결과: 수용 확정(accepted)·연결 실패(no_answer)·확인 생략(skipped) → 이동 중. 열려 있던 병원 요청은 '요청 종료'로 닫는다
//   거절(rejected, SFR-074, A16·A17): 제외 병원에 넣고 다시 계산한 추천의 1순위로 대상을 바꾼다. 없으면 예비 추천
//   결과 미선택(dismissed, SFR-075, A18): 예비 추천으로. 제외하지 않아 같은 병원을 다시 고를 수 있다
//   (거절·미선택 뒤 병원 요청이 아직 열려 있으면 예비 추천 대신 요청 중으로, D-127)
// - 전화 결과 기록은 대원 계정과 연결하지 않는다 (DAR-004). 이벤트에는 ID·상태·시각만 (절대 규칙 5)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import {
  CASCADE,
  TARGET_STATES,
  phoneEvent,
  transitionHreq,
  transitionTransport,
  type HreqStatus,
  type PhoneProceedReason,
} from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { recordRejection } from '../stats/records.js';
import { lockMyTransport, transportIdParam, withCurrentOnBlock } from './access.js';
import { rankForTransport } from './recommend.js';
import { loadTransport } from './view.js';

// version이 빠지면 상태 전이 함수가 VERSION_REQUIRED로 거절한다 (SFR-160)
const startSchema = z.object({
  hospitalId: z.number().int().positive(),
  version: z.number().int().optional(),
});
const resultSchema = z.object({
  hospitalId: z.number().int().positive(),
  result: z.enum(['accepted', 'no_answer', 'skipped', 'rejected', 'dismissed']),
  reason: z.enum(['no_answer', 'busy', 'urgent', 'etc']).nullish(),
  reasonText: z.string().trim().max(30).nullish(),
  // 거절 사유 (선택, SFR-044). 병원 웹 거절과 같은 7가지. '기타' 글은 reasonText 에 20자까지
  rejectReason: z
    .enum(['er_bed', 'or_room', 'ward', 'icu', 'no_specialist', 'equipment', 'etc'])
    .nullish(),
  version: z.number().int().optional(),
});

interface Outcome {
  body: unknown;
  events: LoggedEvent[];
}

async function dbNow(client: pg.PoolClient): Promise<Date> {
  const { rows } = await client.query<{ now: Date }>('SELECT now()');
  return rows[0].now;
}

// 전화 확인을 시작한다 (A13). 대상은 있는 병원이어야 하고, 이번 이송에서 제외된 병원이면 안 된다 (SFR-086)
export async function startPhoneCheck(
  client: pg.PoolClient,
  input: { transportId: string; paramedicId: string; hospitalId: number; clientVersion?: number },
): Promise<Outcome> {
  const { transportId } = input;
  const transport = await lockMyTransport(client, transportId, input.paramedicId);
  const now = await dbNow(client);

  const { rows: hospitals } = await client.query<{ name: string; excluded: boolean }>(
    `SELECT h.name,
            EXISTS (SELECT 1 FROM excluded_hospital e WHERE e.transport_id = $2 AND e.hospital_id = h.id) AS excluded
       FROM hospital h WHERE h.id = $1`,
    [input.hospitalId, transportId],
  );
  if (!hospitals[0]) throw new AppError(404, 'NOT_FOUND', '병원을 찾을 수 없어요');
  if (hospitals[0].excluded) {
    throw new AppError(400, 'VALIDATION_FAILED', '이번 이송에서 제외된 병원이에요', {
      fields: ['hospitalId'],
    });
  }

  // 표(요청 중·예비 추천에서만) → 버전 순서로 판정
  const { to, history } = transitionTransport(transport.status, 'START_PHONE_CHECK', {
    now,
    version: transport.version,
    clientVersion: input.clientVersion,
  });

  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, phone_target_hospital_id = $3, last_activity_at = now(), version = version + 1
      WHERE id = $1 RETURNING version`,
    [transportId, to, input.hospitalId],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );

  const room = `team:${transport.team_id}`;
  const version = updated[0].version;
  const events: EventRecord[] = [
    {
      room,
      name: 'transport.status',
      entityType: 'transport',
      entityId: transportId,
      entityVersion: version,
      payload: {
        transportId,
        status: to,
        event: history.event,
        reason: history.reason,
        byName: null,
      },
    },
    // 팀원 화면도 같은 병원 전화 확인으로 (A13). 병원 이름은 환자 정보가 아니다
    {
      room,
      name: 'transport.phone_target',
      entityType: 'transport',
      entityId: transportId,
      entityVersion: version,
      payload: { transportId, hospitalId: input.hospitalId, hospitalName: hospitals[0].name },
    },
  ];
  return {
    body: await loadTransport(client, transportId, input.paramedicId),
    events: await appendEvents(client, events),
  };
}

export interface PhoneResultInput {
  transportId: string;
  paramedicId: string;
  hospitalId: number;
  result: 'accepted' | 'no_answer' | 'skipped' | 'rejected' | 'dismissed';
  reason?: PhoneProceedReason | null;
  reasonText?: string | null;
  rejectReason?: PhoneRejectReason | null;
  clientVersion?: number;
  // 통신 두절 중 기록을 복구 때 올림 (SFR-099): 앱이 만든 기록 ID(두 번 저장 안 함)와 단말 시각(이미 범위를 맞춘 값)
  offline?: { clientRecordId: string; at: Date };
}

export type PhoneRejectReason =
  'er_bed' | 'or_room' | 'ward' | 'icu' | 'no_specialist' | 'equipment' | 'etc';

// 거절 뒤 다음 후보: 이번 이송 추천(제외 병원 뺌)의 1순위. 앱 추천 목록과 같은 함수로 계산한다 (SFR-074·112)
// 출발 위치가 없어 추천을 못 내는 건은 후보 없음으로 본다
async function nextCandidate(
  client: pg.PoolClient,
  transportId: string,
  paramedicId: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const result = await rankForTransport(client, transportId, paramedicId);
    const first = result?.ranked.items[0];
    return first ? { id: first.id, name: first.row.name } : null;
  } catch (err) {
    if (err instanceof AppError && err.code === 'LOCATION_REQUIRED') return null;
    throw err;
  }
}

// 지금 회차에 대기·아직 유효한 승인이 남았나 (5분 판정은 DB 시각, 전화 확인에서 돌아갈 상태를 고름)
async function openRequestsRemain(client: pg.PoolClient, transportId: string): Promise<boolean> {
  const { rows } = await client.query<{ open: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $1
          AND r.round_no = (SELECT max(round_no) FROM request_round WHERE transport_id = $1)
          AND (hr.status = 'waiting' OR (hr.status = 'approved' AND now() < r.approval_valid_until))
     ) AS open`,
    [transportId],
  );
  return rows[0].open;
}

// 전화 확인 결과를 기록한다 (SFR-034). 출발(A14·A15) · 거절(A16·A17) · 미선택(A18)
export async function recordPhoneResult(
  client: pg.PoolClient,
  input: PhoneResultInput,
): Promise<Outcome> {
  const { transportId } = input;
  const transport = await lockMyTransport(client, transportId, input.paramedicId);
  const now = await dbNow(client);

  const { rows: targets } = await client.query<{ phone_target_hospital_id: string | null }>(
    'SELECT phone_target_hospital_id FROM transport WHERE id = $1',
    [transportId],
  );
  const proceeding = input.result === 'no_answer' || input.result === 'skipped';
  const ctx = {
    now,
    version: transport.version,
    clientVersion: input.clientVersion,
    phoneReason: proceeding ? (input.reason ?? undefined) : undefined,
  };
  // 표 → 사유(연결 실패·확인 생략은 사유 필수) → 버전 순서로 먼저 판정한다.
  // 거절은 다음 후보가 있는지 알아야 사건이 정해지지만, 상태·버전 검사는 두 사건(A16·A17)이 같아서 '후보 없음'으로 먼저 본다
  let event = phoneEvent(input.result, false);
  let { to, history } = transitionTransport(transport.status, event, ctx);
  // 팀원이 그사이 대상 병원을 바꿨으면 다른 병원 결과가 기록되면 안 된다 (버전이 같아도 한 번 더 확인)
  if (String(input.hospitalId) !== targets[0].phone_target_hospital_id) {
    throw new AppError(400, 'VALIDATION_FAILED', '지금 전화 확인 중인 병원이 아니에요', {
      fields: ['hospitalId'],
    });
  }

  // 거절 사유는 거절일 때만, '기타' 글은 20자까지 (SFR-044)
  const rejecting = input.result === 'rejected';
  const rejectReason = input.rejectReason ?? null;
  if (rejectReason && !rejecting) {
    throw new AppError(400, 'VALIDATION_FAILED', '거절 사유는 거절일 때만 보낼 수 있어요', {
      fields: ['rejectReason'],
    });
  }
  const rejectText = rejectReason === 'etc' ? input.reasonText || null : null;
  if (rejectText && rejectText.length > 20) {
    throw new AppError(400, 'VALIDATION_FAILED', '기타 사유는 20자까지 쓸 수 있어요', {
      fields: ['reasonText'],
    });
  }

  // 결과 기록: 결과·사유·시각만, 기록한 대원은 남기지 않는다 (DAR-004)
  await client.query(
    `INSERT INTO phone_check (transport_id, hospital_id, result, reason, reject_reason, reason_text, created_at,
                              offline, client_record_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      transportId,
      input.hospitalId,
      input.result,
      proceeding ? input.reason : null,
      rejectReason,
      proceeding ? (input.reasonText ?? null) : rejectText,
      input.offline?.at ?? now,
      input.offline !== undefined,
      input.offline?.clientRecordId ?? null,
    ],
  );

  if (input.result === 'rejected' || input.result === 'dismissed') {
    let next: { id: string; name: string } | null = null;
    if (input.result === 'rejected') {
      // 거절한 병원은 이번 이송 추천·요청 대상에서 뺀다 (SFR-086). 병원 거절 통계에는 넣지 않는다 (출처가 따로 있음)
      await client.query(
        `INSERT INTO excluded_hospital (transport_id, hospital_id, reason) VALUES ($1, $2, 'phone_rejected')
         ON CONFLICT DO NOTHING`,
        [transportId, input.hospitalId],
      );
      // 통계 원장에는 출처 '전화 확인'으로 남긴다. 사유를 안 고르면 사유 없이 1건 (SFR-126)
      await recordRejection(client, {
        transportId,
        hospitalId: input.hospitalId,
        source: 'phone_check',
        reason: rejectReason,
        reasonText: rejectText,
      });
      next = await nextCandidate(client, transportId, input.paramedicId);
    }
    event = phoneEvent(input.result, next !== null);
    ({ to, history } = transitionTransport(transport.status, event, {
      ...ctx,
      openRequestsRemain: await openRequestsRemain(client, transportId),
    }));
    return backToList(client, {
      transportId,
      paramedicId: input.paramedicId,
      teamId: transport.team_id,
      to,
      history,
      next,
    });
  }

  // 연쇄: 열려 있던 병원 요청(대기·승인) → 닫힘(fallback). 병원 웹 '요청 종료' (A-2 41)
  // 앞 회차에 남은 열린 요청도 함께 닫는다. id 순서로 잠근다 (stateMachine.ts 규칙 5)
  const events: EventRecord[] = [];
  for (const { target, event: hreqEvent } of CASCADE[event] ?? []) {
    const states = TARGET_STATES[target as keyof typeof TARGET_STATES];
    const { rows: requests } = await client.query<{
      id: string;
      hospital_id: string;
      status: HreqStatus;
      version: number;
    }>(
      `SELECT hr.id, hr.hospital_id, hr.status, hr.version
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $1 AND hr.status = ANY($2::hreq_status[])
        ORDER BY hr.id
        FOR UPDATE OF hr`,
      [transportId, states],
    );
    for (const request of requests) {
      const result = transitionHreq(request.status, hreqEvent, { now, version: request.version });
      const { rows: closed } = await client.query<{ version: number }>(
        `UPDATE hospital_request SET status = $2, closed_reason = $3, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [request.id, result.to, result.closeReason],
      );
      events.push({
        room: `hospital:${request.hospital_id}`,
        name: 'request.changed',
        entityType: 'hospital_request',
        entityId: request.id,
        entityVersion: closed[0].version,
        payload: {
          requestId: Number(request.id),
          status: result.to,
          closeReason: result.closeReason,
          byName: null,
          pcName: null,
        },
      });
    }
  }

  // 목적지 = 전화한 병원. 출발 시각은 처음만 (SFR-036). 전화 확인 대상은 끝났으니 비운다
  const { rows: moved } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, confirmed_hospital_id = $3, confirmed_at = now(), phone_target_hospital_id = NULL,
            departed_at = coalesce(departed_at, now()), last_activity_at = now(), version = version + 1
      WHERE id = $1 RETURNING version`,
    [transportId, to, input.hospitalId],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );
  events.push({
    room: `team:${transport.team_id}`,
    name: 'transport.status',
    entityType: 'transport',
    entityId: transportId,
    entityVersion: moved[0].version,
    payload: {
      transportId,
      status: to,
      event: history.event,
      reason: history.reason,
      byName: null,
    },
  });

  return {
    body: await loadTransport(client, transportId, input.paramedicId),
    events: await appendEvents(client, events),
  };
}

// 거절·미선택 뒤: 다음 후보가 있으면 대상만 바꿔 전화 확인을 이어 가고(A16),
// 없으면 예비 추천(또는 요청이 열려 있으면 요청 중)으로 돌아간다(A17·A18). 병원 요청은 건드리지 않는다
async function backToList(
  client: pg.PoolClient,
  input: {
    transportId: string;
    paramedicId: string;
    teamId: string;
    to: ReturnType<typeof transitionTransport>['to'];
    history: ReturnType<typeof transitionTransport>['history'];
    next: { id: string; name: string } | null;
  },
): Promise<Outcome> {
  const { transportId, to, history, next } = input;
  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, phone_target_hospital_id = $3, last_activity_at = now(), version = version + 1,
            fallback_reason = CASE WHEN $2::transport_status = 'fallback' THEN $4 ELSE fallback_reason END
      WHERE id = $1 RETURNING version`,
    [transportId, to, next?.id ?? null, history.reason],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );
  const room = `team:${input.teamId}`;
  const version = updated[0].version;
  const events: EventRecord[] = [
    {
      room,
      name: 'transport.status',
      entityType: 'transport',
      entityId: transportId,
      entityVersion: version,
      payload: {
        transportId,
        status: to,
        event: history.event,
        reason: history.reason,
        byName: null,
      },
    },
  ];
  // 팀원 화면도 다음 병원 전화 확인으로 (A16)
  if (next) {
    events.push({
      room,
      name: 'transport.phone_target',
      entityType: 'transport',
      entityId: transportId,
      entityVersion: version,
      payload: { transportId, hospitalId: Number(next.id), hospitalName: next.name },
    });
  }
  return {
    body: await loadTransport(client, transportId, input.paramedicId),
    events: await appendEvents(client, events),
  };
}

export function phoneCheckRouter(
  pool: pg.Pool,
  guards: RequestHandler[],
  realtime?: Realtime,
): Router {
  const router = Router();

  router.post('/transports/:transportId/phone-check/start', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const input = parseBody(startSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    const outcome = await withCurrentOnBlock(pool, transportId, paramedicId, () =>
      withTransaction(pool, (client) =>
        startPhoneCheck(client, {
          transportId,
          paramedicId,
          hospitalId: input.hospitalId,
          clientVersion: input.version,
        }),
      ),
    );
    // 커밋된 뒤에만 보낸다
    realtime?.publish(outcome.events);
    res.json(outcome.body);
  });

  router.post('/transports/:transportId/phone-checks', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const input = parseBody(resultSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    const outcome = await withCurrentOnBlock(pool, transportId, paramedicId, () =>
      withTransaction(pool, (client) =>
        recordPhoneResult(client, {
          transportId,
          paramedicId,
          hospitalId: input.hospitalId,
          result: input.result,
          reason: input.reason,
          reasonText: input.reasonText,
          rejectReason: input.rejectReason,
          clientVersion: input.version,
        }),
      ),
    );
    realtime?.publish(outcome.events);
    res.status(201).json(outcome.body);
  });

  return router;
}
