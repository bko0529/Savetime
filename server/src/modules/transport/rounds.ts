// 새 요청 회차: 반경 넓혀 다시 요청 (SFR-131, 부록 A12) · 승인 취소 뒤 다시 요청 (SFR-128, 부록 A20·A21)
// + 목적지 변경 (SFR-077, destination.ts) + 요청 대상 미리보기 (SFR-163). 상태 변경은 stateMachine.ts 전이 함수만 거친다 (절대 규칙 4).
// 대상 찾기·회차 만들기는 이송 생성과 같은 함수(requestTargets.ts)를 쓴다.
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { isInKorea, RADIUS_KM } from '../../domain/geo.js';
import { transitionTransport, type CloseReason } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { inheritedExclusions } from '../team/prevPatient.js';
import { currentTeamId } from '../team/routes.js';
import { lockMyTransport, transportIdParam, withCurrentOnBlock } from './access.js';
import { changeDestination, destinationSchema } from './destination.js';
import type { EtaLookup } from './eta.js';
import { findRequestTargets, insertRound, previewRequestTargets } from './requestTargets.js';
import { refineRoundEtas } from './routeEta.js';
import { loadTransport } from './view.js';

const radius = z
  .number()
  .int()
  .refine((v) => (RADIUS_KM as readonly number[]).includes(v));

const roundSchema = z.object({
  kind: z.enum(['expand', 're_request']),
  // expand일 때 다음 단계 1칸. 한 단계인지는 상태 전이 함수가 판정한다 (MAX_RADIUS)
  radiusKm: radius.optional(),
  // re_request: 지금 위치 기준 (SFR-128). 없으면 출발 위치로
  location: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  version: z.number().int().optional(),
});

const previewSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radiusKm: z.coerce.number().pipe(radius),
  grade: z.coerce
    .number()
    .pipe(z.union([z.literal(1), z.literal(2), z.literal(3)]))
    .optional(),
  // 직전 건(10분 안·같은 팀)의 수용 불가 병원을 빼고 센다. 이송 생성과 같은 규칙 (SFR-157)
  prevTransportId: z.uuid().optional(),
});

function checkKorea(lat: number, lng: number, field: string): void {
  if (!isInKorea(lat, lng)) {
    throw new AppError(400, 'VALIDATION_FAILED', '좌표 범위 오류: 대한민국 밖 좌표예요', {
      fields: [field],
      reason: 'coords_out_of_korea',
    });
  }
}

interface RoundInput {
  transportId: string;
  paramedicId: string;
  kind: 'expand' | 're_request';
  radiusKm?: number;
  location?: { lat: number; lng: number } | null;
  clientVersion?: number;
}

interface RoundOutcome {
  body: unknown;
  events: LoggedEvent[];
  roundId: string;
}

export async function startRound(client: pg.PoolClient, input: RoundInput): Promise<RoundOutcome> {
  const { transportId } = input;
  // 이송 건 행부터 잠근다 (stateMachine.ts 규칙 5). 팀원 둘이 같이 눌러도 회차는 1개
  const transport = await lockMyTransport(client, transportId, input.paramedicId);
  const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
  const now = clock[0].now;

  const { rows } = await client.query<{
    origin_lat: number | null;
    origin_lng: number | null;
    request_radius_km: number;
    requested_grade: number | null;
    confirmed_closed_reason: CloseReason | null;
  }>(
    `SELECT t.origin_lat::float8 AS origin_lat, t.origin_lng::float8 AS origin_lng,
            t.request_radius_km, t.requested_grade,
            (SELECT hr.closed_reason FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
              WHERE r.transport_id = t.id AND hr.hospital_id = t.confirmed_hospital_id
                AND hr.closed_reason = 'approval_cancelled'
              ORDER BY hr.id DESC LIMIT 1) AS confirmed_closed_reason
       FROM transport t WHERE t.id = $1`,
    [transportId],
  );
  const t = rows[0];

  const expand = input.kind === 'expand';
  // 다시 요청은 지금 위치(앱이 보냄), 반경 넓히기는 출발 위치 기준
  const at =
    !expand && input.location
      ? input.location
      : t.origin_lat !== null && t.origin_lng !== null
        ? { lat: t.origin_lat, lng: t.origin_lng }
        : null;
  if (!at) throw new AppError(409, 'LOCATION_REQUIRED', '출발 위치를 알 수 없어요');
  checkKorea(at.lat, at.lng, 'location');

  // 반경 넓히기: 넓힌 반경 안에서 이번 이송에 아직 요청 안 한 병원만 (SFR-131)
  // 다시 요청: 지금 반경 안에서 제외 병원(승인 취소·거절한 병원 등)만 빼고 (SFR-128). 고른 등급은 그대로 (SFR-162)
  const radiusKm = expand ? (input.radiusKm ?? t.request_radius_km) : t.request_radius_km;
  const targets = await findRequestTargets(client, {
    lat: at.lat,
    lng: at.lng,
    radiusKm,
    grade: t.requested_grade,
    transport: { id: transportId, skipAlreadyRequested: expand },
  });

  // 표 → 상태 조건(한 단계·40km·대상 0곳 / 확정 병원 승인 취소) → 버전 순서로 판정
  const { to, history } = transitionTransport(
    transport.status,
    expand ? 'EXPAND_ROUND' : 'RE_REQUEST',
    {
      now,
      version: transport.version,
      clientVersion: input.clientVersion,
      currentRadiusKm: t.request_radius_km,
      nextRadiusKm: input.radiusKm,
      newTargetCount: targets.length,
      confirmedReqClosedReason: t.confirmed_closed_reason,
    },
  );

  // 다시 요청 중에도 경로 안내·출발 시각은 그대로다 (SFR-128). 목적지 변경 횟수에도 세지 않는다
  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, request_radius_km = $3, last_activity_at = now(), version = version + 1
      WHERE id = $1 RETURNING version`,
    [transportId, to, radiusKm],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );
  const version = updated[0].version;
  const round = await insertRound(client, {
    transportId,
    kind: input.kind,
    radiusKm,
    targets,
    now,
    entityVersion: version,
  });

  const room = `team:${transport.team_id}`;
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
    { ...round.event, room },
  ];
  return {
    body: await loadTransport(client, transportId, input.paramedicId),
    events: await appendEvents(client, events),
    roundId: round.roundId,
  };
}

export function roundsRouter(
  pool: pg.Pool,
  guards: RequestHandler[],
  realtime?: Realtime,
  eta?: EtaLookup,
): Router {
  const router = Router();

  router.post('/transports/:transportId/rounds', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const input = parseBody(roundSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    const outcome = await withCurrentOnBlock(pool, transportId, paramedicId, () =>
      withTransaction(pool, (client) =>
        startRound(client, {
          transportId,
          paramedicId,
          kind: input.kind,
          radiusKm: input.radiusKm,
          location: input.location,
          clientVersion: input.version,
        }),
      ),
    );
    // 커밋된 뒤에만: 팀원 화면 + 병원 PC에 request.new(5초 받았음) + 2분·5분 타이머 (이송 생성과 같음)
    realtime?.publish(outcome.events);
    realtime?.startRound(outcome.roundId);
    if (eta) {
      refineRoundEtas(pool, eta, outcome.roundId)
        .then((events) => realtime?.publish(events))
        .catch(() => {});
    }
    res.status(201).json(outcome.body);
  });

  // 목적지 변경 (SFR-077). 새 회차를 보내는 일이라 커밋 뒤 처리(타이머·길찾기)가 다시 요청과 같다
  router.post('/transports/:transportId/destination', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const input = parseBody(destinationSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    const outcome = await withCurrentOnBlock(pool, transportId, paramedicId, () =>
      withTransaction(pool, (client) =>
        changeDestination(client, {
          transportId,
          paramedicId,
          reason: input.reason,
          location: input.location,
          clientVersion: input.version,
        }),
      ),
    );
    realtime?.publish(outcome.events);
    realtime?.startRound(outcome.roundId);
    if (eta) {
      refineRoundEtas(pool, eta, outcome.roundId)
        .then((events) => realtime?.publish(events))
        .catch(() => {});
    }
    res.json(outcome.body);
  });

  // '병원에 요청'을 누르기 전에 지금 조건으로 요청이 갈 병원 수 (SFR-163)
  router.get('/request-targets/preview', ...guards, async (req, res) => {
    const parsed = previewSchema.safeParse(req.query);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      throw new AppError(400, 'VALIDATION_FAILED', '입력 형식이 맞지 않아요', { fields });
    }
    const { lat, lng, radiusKm, grade, prevTransportId } = parsed.data;
    checkKorea(lat, lng, 'lat');
    const teamId = prevTransportId
      ? await currentTeamId(pool, paramedicAuth(res).paramedicId)
      : null;
    const inherited = teamId ? await inheritedExclusions(pool, teamId, prevTransportId) : null;
    const result = await previewRequestTargets(pool, {
      lat,
      lng,
      radiusKm,
      grade: grade ?? null,
      excludeHospitalIds: inherited?.hospitalIds,
    });
    const { rows } = await pool.query<{ now: Date }>('SELECT now()');
    res.json({ ...result, serverNow: rows[0].now.toISOString() });
  });

  return router;
}
