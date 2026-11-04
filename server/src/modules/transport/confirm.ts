// 승인 병원 확정 (SFR-111·125·160, 부록 A7·A31, A-2 40·42). 상태 변경은 stateMachine.ts 전이 함수만 거친다 (절대 규칙 4).
// - 같은 확정을 여러 번 보내도 한 번만: Idempotency-Key별 첫 결과를 idempotency_key에 저장해 그대로 돌려준다
// - 5분 판정은 '첫 시도가 서버에 도착한 시각': 키마다 처음 본 DB 시각을 Redis에 한 번만 적어 둔다 (서버 2대가 같이 봄, 규칙 7)
// - 버전 번호로 먼저 온 확정 하나만 반영하고, 늦게 온 쪽에는 최신 상태(details.current)를 돌려준다
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import {
  CASCADE,
  TARGET_STATES,
  TransitionError,
  transitionHreq,
  transitionTransport,
  type CloseReason,
  type HreqStatus,
  type TransportStatus,
} from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import type { AuthContext } from '../auth/session.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { loadTransport } from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 앱이 재시도하는 동안만 필요하다. 5분 판정이 끝난 뒤에는 의미가 없어 10분 뒤 지운다
const FIRST_ARRIVAL_SECONDS = 600;

const bodySchema = z.object({
  hospitalRequestId: z.number().int().positive(),
  // 빠지면 상태 전이 함수가 VERSION_REQUIRED로 거절한다 (SFR-160)
  version: z.number().int().optional(),
});
const keySchema = z.string().min(1).max(64);

const notFound = () => new AppError(404, 'NOT_FOUND', '이송 건을 찾을 수 없어요');

interface ConfirmInput {
  transportId: string;
  paramedicId: string;
  key: string;
  hospitalRequestId: number;
  clientVersion: number | undefined;
  firstArrival: Date; // 이 키의 첫 시도가 서버에 도착한 DB 시각
}

interface ConfirmOutcome {
  body: unknown;
  events: LoggedEvent[];
}

export async function confirmTransport(
  client: pg.PoolClient,
  input: ConfirmInput,
): Promise<ConfirmOutcome> {
  const { transportId, paramedicId, firstArrival } = input;

  // 내 팀 이송 건만. 남의 것은 있는지조차 알리지 않는다 (SER-010). 이송 건 행부터 잠근다 (stateMachine.ts 규칙 5)
  const { rows: transports } = await client.query<{
    status: TransportStatus;
    version: number;
    team_id: string;
    location_consent: boolean;
  }>(
    `SELECT t.status, t.version, t.team_id, t.location_consent
       FROM transport t
       JOIN team_member tm ON tm.team_id = t.team_id AND tm.left_at IS NULL AND tm.paramedic_id = $2
      WHERE t.id = $1
      FOR UPDATE OF t`,
    [transportId, paramedicId],
  );
  const transport = transports[0];
  if (!transport) throw notFound();

  // 같은 키로 이미 확정했으면 처음 결과를 그대로 (앱의 '확정 중' 재시도, SFR-111). 잠근 뒤에 봐야 동시 재시도도 한 번만
  const { rows: done } = await client.query<{ transport_id: string; response: unknown }>(
    'SELECT transport_id, response FROM idempotency_key WHERE key = $1',
    [input.key],
  );
  if (done[0]) {
    if (done[0].transport_id !== transportId) {
      throw new AppError(400, 'VALIDATION_FAILED', '입력 형식이 맞지 않아요', {
        fields: ['Idempotency-Key'],
      });
    }
    return { body: done[0].response, events: [] };
  }

  const { rows: targets } = await client.query<{
    id: string;
    hospital_id: string;
    hospital_name: string;
    eta_min: number | null;
    memo: string | null;
    approval_valid_until: Date;
  }>(
    `SELECT hr.id, hr.hospital_id, h.name AS hospital_name, hr.eta_min, hr.memo, r.approval_valid_until
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       JOIN hospital h ON h.id = hr.hospital_id
      WHERE hr.id = $1 AND r.transport_id = $2`,
    [input.hospitalRequestId, transportId],
  );
  const target = targets[0];
  if (!target) throw new AppError(404, 'NOT_FOUND', '병원 요청을 찾을 수 없어요');

  // 고른 요청과 아직 열린 요청(대기·승인)을 id 순서로 잠근다. 앞 회차에 남은 열린 요청도 함께 닫는다
  const { rows: requests } = await client.query<{
    id: string;
    hospital_id: string;
    status: HreqStatus;
    closed_reason: CloseReason | null;
    version: number;
  }>(
    `SELECT hr.id, hr.hospital_id, hr.status, hr.closed_reason, hr.version
       FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
      WHERE r.transport_id = $1 AND (hr.id = $2 OR hr.status = ANY($3::hreq_status[]))
      ORDER BY hr.id
      FOR UPDATE OF hr`,
    [transportId, target.id, TARGET_STATES.open],
  );
  const chosen = requests.find((r) => r.id === target.id)!;

  // 표·승인 상태(취소·만료·미승인)·버전 순서로 판정. 5분은 첫 도착 시각으로 잰다 (SFR-111·160)
  const { to, history } = transitionTransport(transport.status, 'CONFIRM', {
    now: firstArrival,
    version: transport.version,
    clientVersion: input.clientVersion,
    target: {
      status: chosen.status,
      closeReason: chosen.closed_reason,
      approvalValidUntil: target.approval_valid_until,
    },
  });

  const events: EventRecord[] = [];
  // 연쇄: 고른 병원 → 확정, 나머지 대기·승인 → 닫힘(다른 병원으로 이송) (SFR-125)
  for (const { target: who, event } of CASCADE.CONFIRM ?? []) {
    const affected =
      who === 'chosen'
        ? [chosen]
        : requests.filter((r) => r.id !== chosen.id && TARGET_STATES.open.includes(r.status));
    for (const request of affected) {
      const result = transitionHreq(request.status, event, {
        now: firstArrival,
        version: request.version,
      });
      const { rows: updated } = await client.query<{ version: number }>(
        `UPDATE hospital_request SET status = $2, closed_reason = $3, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [request.id, result.to, result.closeReason],
      );
      // 병원 웹은 이걸 받으면 그 행을 다시 받는다. 닫혔으면 열려 있던 상세의 환자 정보를 바로 지운다 (SER-014)
      events.push({
        room: `hospital:${request.hospital_id}`,
        name: 'request.changed',
        entityType: 'hospital_request',
        entityId: request.id,
        entityVersion: updated[0].version,
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

  const { rows: moved } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, confirmed_hospital_id = $3, confirmed_at = now(),
            departed_at = coalesce(departed_at, now()), last_activity_at = now(), version = version + 1
      WHERE id = $1 RETURNING version`,
    [transportId, to, target.hospital_id],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [transportId, history.from, history.to, history.event, history.reason],
  );

  const { rows: me } = await client.query<{ name: string }>(
    'SELECT name FROM paramedic WHERE id = $1',
    [paramedicId],
  );
  // 팀원 화면: '김도윤 님이 B병원을 선택했어요' (SFR-160). 대원 이름이라 환자 정보가 아니다
  events.push({
    room: `team:${transport.team_id}`,
    name: 'transport.confirmed',
    entityType: 'transport',
    entityId: transportId,
    entityVersion: moved[0].version,
    payload: {
      transportId,
      hospitalId: Number(target.hospital_id),
      hospitalName: target.hospital_name,
      byName: me[0].name,
      etaMin: target.eta_min,
      memo: target.memo,
      // 경로 안내 담당 단말은 SFR-132(S6)에서 정한다
      navDeviceId: null,
    },
  });
  // 확정 병원 도착 예정 목록에 추가 (SFR-121). 내용은 GET /hw/incoming으로
  events.push({
    room: `hospital:${target.hospital_id}`,
    name: 'incoming.added',
    entityType: 'hospital_request',
    entityId: target.id,
    payload: {
      requestId: Number(target.id),
      label: '도착 예정 환자',
      etaMin: target.eta_min,
      hasLocation: transport.location_consent,
    },
  });

  const body = await loadTransport(client, transportId, paramedicId);
  await client.query(
    'INSERT INTO idempotency_key (key, transport_id, response) VALUES ($1, $2, $3)',
    [input.key, transportId, JSON.stringify(body)],
  );
  return { body, events: await appendEvents(client, events) };
}

export function confirmRouter(
  auth: AuthContext,
  guards: RequestHandler[],
  realtime?: Realtime,
): Router {
  const router = Router();
  const { pool, redis } = auth;

  router.post('/transports/:transportId/confirm', ...guards, async (req, res) => {
    const transportId = String(req.params.transportId);
    if (!UUID.test(transportId)) throw notFound();
    const key = keySchema.safeParse(req.get('Idempotency-Key'));
    if (!key.success) {
      throw new AppError(400, 'VALIDATION_FAILED', '입력 형식이 맞지 않아요', {
        fields: ['Idempotency-Key'],
      });
    }
    const input = parseBody(bodySchema, req.body);
    const { paramedicId } = paramedicAuth(res);

    // 이 키의 첫 도착 시각. 이미 있으면 그대로 두고(NX) 그 값을 쓴다. Redis가 안 되면 지금 시각으로 판정한다
    const { rows: clock } = await pool.query<{ now: Date }>('SELECT now()');
    let firstArrival = clock[0].now;
    try {
      const redisKey = `confirm:first:${key.data}`;
      await redis.set(redisKey, firstArrival.toISOString(), 'EX', FIRST_ARRIVAL_SECONDS, 'NX');
      const stored = await redis.get(redisKey);
      if (stored) firstArrival = new Date(stored);
    } catch {
      // 판정 기준만 조금 늦어진다. 확정 자체를 막지는 않는다
    }

    try {
      const outcome = await withTransaction(pool, (client) =>
        confirmTransport(client, {
          transportId,
          paramedicId,
          key: key.data,
          hospitalRequestId: input.hospitalRequestId,
          clientVersion: input.version,
          firstArrival,
        }),
      );
      // 커밋된 뒤에만 보낸다
      realtime?.publish(outcome.events);
      res.json(outcome.body);
    } catch (err) {
      // 막힌 이유와 함께 최신 상태를 돌려줘 앱이 바로 화면을 바꾸게 한다 (SFR-160, 오류 코드표 details.current)
      if (err instanceof TransitionError) {
        const current = await loadTransport(pool, transportId, paramedicId);
        throw new AppError(err.code === 'VERSION_REQUIRED' ? 400 : 409, err.code, err.message, {
          current,
        });
      }
      throw err;
    }
  });

  return router;
}
