// 이송 건 만들기 + 병원에 동시 요청 (SFR-109·086·104·162·129) / 진행 중 이송 불러오기 (SFR-133)
// 상태는 모두 stateMachine.ts 전이 함수를 거친다 (절대 규칙 4). 팀 1건 규칙은 팀 행 잠금 + DB 유니크 인덱스 두 겹.
// 병원 웹으로 request.new를 실제로 보내고 5초 '받았음'을 세는 일은 실시간 모듈(SFR-161)이 맡는다.
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { isInKorea, RADIUS_KM } from '../../domain/geo.js';
import {
  ACTIVE,
  CASCADE,
  TARGET_STATES,
  transitionHreq,
  transitionTransport,
  type TransportStatus,
} from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { currentTeamId } from '../team/routes.js';
import { loadTransport } from './view.js';

// 요청용 도착 예상 시간 초안: 직선거리 ÷ 평균 40km/h (SFR-129). 길찾기 갱신은 뒤에 붙인다.
const STRAIGHT_KMH = 40;

const nullableInt = z.number().int().nullable().optional();

// 환자 평가 (openapi Assessment). strict: 이름·주민번호·연락처처럼 정해지지 않은 칸이 오면 통째로 거절한다 (SER-012)
const assessmentSchema = z
  .object({
    chiefComplaint: z.string().max(100).optional(),
    sex: z.enum(['M', 'F', 'U']).optional(),
    ageBand: z.string().max(10).optional(),
    consciousness: z.enum(['alert', 'verbal', 'pain', 'unresponsive', 'unknown']).optional(),
    bp: z.string().max(10).optional(),
    pulse: nullableInt,
    resp: nullableInt,
    spo2: nullableInt,
    painSite: z.string().max(30).nullable().optional(),
    painScore: z.number().int().min(0).max(10).nullable().optional(),
    onset: z.string().max(30).nullable().optional(),
    trauma: z.enum(['yes', 'no', 'unknown']).optional(),
    traumaCause: z
      .enum(['traffic', 'fall_high', 'fall', 'penetrating', 'burn', 'etc'])
      .nullable()
      .optional(),
    history: z.string().max(500).nullable().optional(),
    temp: z.number().min(20).max(45).nullable().optional(),
    glucose: nullableInt,
    ktas: z.number().int().min(1).max(5).nullable().optional(),
    unknownFields: z.array(z.string().max(30)).max(30).optional(),
  })
  .strict();

const createSchema = z.object({
  id: z.uuid(),
  // 직전 건의 제외 병원 이어받기(SFR-157)는 S4 예외 흐름에서 붙인다. 지금은 받기만 하고 쓰지 않는다
  prevTransportId: z.uuid().nullable().optional(),
  finishPrevious: z.boolean().optional(),
  previousVersion: z.number().int().nullable().optional(),
  radiusKm: z
    .number()
    .int()
    .refine((v) => (RADIUS_KM as readonly number[]).includes(v)),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  address: z.string().max(120).nullable().optional(),
  locationConsent: z.boolean(),
  assessment: assessmentSchema,
  requestedGrade: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .nullable()
    .optional(),
});
type CreateInput = z.infer<typeof createSchema>;

interface Target {
  id: string;
  km: number;
}

// 요청 대상 = 반경 안 · 병원 계정 활성 · 잠시 요청 중지 아님 · 알림 켠 PC가 있음 · 고른 등급 이상 (SFR-109·117·139·162)
// 반경은 위도·경도 네모로 먼저 거르고 하버사인 직선거리로 자른다 (추천 목록과 같은 방식)
const TARGETS_SQL = `
  SELECT h.id, d.km
    FROM hospital h
    CROSS JOIN LATERAL (
      SELECT 2 * 6371 * asin(sqrt(
               power(sin(radians(h.lat::float8 - $1) / 2), 2)
               + cos(radians($1)) * cos(radians(h.lat::float8))
                 * power(sin(radians(h.lng::float8 - $2) / 2), 2))) AS km
    ) d
   WHERE h.lat BETWEEN $1 - $3 / 111.0 AND $1 + $3 / 111.0
     AND h.lng BETWEEN $2 - $3 / (111.0 * cos(radians($1))) AND $2 + $3 / (111.0 * cos(radians($1)))
     AND d.km <= $3
     AND h.account_active AND NOT h.requests_paused
     AND ($4::int IS NULL OR h.grade <= $4)
     AND EXISTS (
       SELECT 1 FROM hospital_shift s JOIN hospital_pc p ON p.id = s.pc_id
        WHERE p.hospital_id = h.id AND p.released_at IS NULL
          AND s.alarm_on_at IS NOT NULL AND s.ended_at IS NULL
     )
   ORDER BY d.km, h.id`;

// '이동 중'인 이전 건을 도착(finish_previous)으로 끝낸다 (부록 A23). 새 건을 만드는 같은 트랜잭션에서 부른다
async function finishPrevious(
  client: pg.PoolClient,
  now: Date,
  previous: { id: string; status: TransportStatus; version: number },
  clientVersion: number | undefined,
): Promise<EventRecord> {
  const { to, history } = transitionTransport(previous.status, 'FINISH_PREVIOUS', {
    now,
    version: previous.version,
    clientVersion,
  });
  const { rows } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, arrived_at = now(), arrival_method = 'finish_previous', version = version + 1
      WHERE id = $1 RETURNING version`,
    [previous.id, to],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [previous.id, history.from, history.to, history.event, history.reason, history.at],
  );
  // 연쇄: 확정 병원 요청 → 도착 (부록 A-2 46)
  for (const { target, event } of CASCADE.FINISH_PREVIOUS ?? []) {
    const { rows: requests } = await client.query<{
      id: string;
      status: 'confirmed';
      version: number;
    }>(
      `SELECT hr.id, hr.status, hr.version
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $1 AND hr.status = ANY($2::hreq_status[])
        ORDER BY hr.id FOR UPDATE OF hr`,
      [previous.id, TARGET_STATES[target as keyof typeof TARGET_STATES]],
    );
    for (const request of requests) {
      const result = transitionHreq(request.status, event, { now, version: request.version });
      await client.query(
        `UPDATE hospital_request SET status = $2, arrived_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1`,
        [request.id, result.to],
      );
    }
  }
  return {
    room: '',
    name: 'transport.arrived',
    entityType: 'transport',
    entityId: previous.id,
    entityVersion: rows[0].version,
    payload: { transportId: previous.id, method: 'finish_previous' },
  };
}

// 커밋한 뒤 실시간으로 보낼 것: 기록된 이벤트와 병원에 보낼 회차
type CreateOutcome = { transportId: string; events: LoggedEvent[]; roundId: string | null };

export async function createTransport(
  client: pg.PoolClient,
  paramedicId: string,
  input: CreateInput,
): Promise<CreateOutcome> {
  const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
  const now = clock[0].now;

  const teamId = await currentTeamId(client, paramedicId);
  if (!teamId) throw new AppError(404, 'NOT_IN_TEAM', '근무 중인 팀이 없어요');
  // 팀 행을 잠가 같은 팀의 '병원에 요청'을 한 줄로 세운다. 두 팀원이 동시에 눌러도 이송 건은 1개 (SFR-104)
  await client.query('SELECT id FROM team WHERE id = $1 FOR UPDATE', [teamId]);

  // 같은 id로 다시 보내면(응답을 못 받은 앱의 재시도) 처음 결과를 돌려준다
  const { rows: same } = await client.query<{ team_id: string | null }>(
    'SELECT team_id FROM transport WHERE id = $1',
    [input.id],
  );
  if (same[0]) {
    if (same[0].team_id !== teamId) {
      throw new AppError(400, 'VALIDATION_FAILED', '입력 형식이 맞지 않아요', { fields: ['id'] });
    }
    // 이미 보낸 이벤트·요청은 다시 보내지 않는다
    return { transportId: input.id, events: [], roundId: null };
  }

  const { rows: active } = await client.query<{
    id: string;
    status: TransportStatus;
    version: number;
    hospital_name: string | null;
  }>(
    `SELECT t.id, t.status, t.version, h.name AS hospital_name
       FROM transport t LEFT JOIN hospital h ON h.id = t.confirmed_hospital_id
      WHERE t.team_id = $1 AND t.status = ANY($2::transport_status[])
      FOR UPDATE OF t`,
    [teamId, ACTIVE],
  );
  const previous = active[0];
  const events: EventRecord[] = [];
  if (previous) {
    // '이동 중'이고 대원이 '이전 이송 끝내기'를 확인했을 때만 이어서 만든다. 아니면 그 화면으로 보낸다
    if (!(input.finishPrevious && previous.status === 'moving')) {
      throw new AppError(409, 'ACTIVE_TRANSPORT_EXISTS', '팀에 진행 중 이송이 있어요', {
        activeTransport: {
          id: previous.id,
          status: previous.status,
          version: previous.version,
          hospitalName: previous.hospital_name,
        },
      });
    }
    events.push(await finishPrevious(client, now, previous, input.previousVersion ?? undefined));
  }

  if (!input.location) {
    // 위치를 못 쓰면 앱이 주소→좌표 변환(GET /geocode) 결과를 location으로 보낸다
    throw new AppError(409, 'LOCATION_REQUIRED', '출발 위치를 알 수 없어요');
  }
  const { lat, lng } = input.location;
  if (!isInKorea(lat, lng)) {
    throw new AppError(400, 'VALIDATION_FAILED', '좌표 범위 오류: 대한민국 밖 좌표예요', {
      fields: ['location'],
      reason: 'coords_out_of_korea',
    });
  }

  const { rows: targets } = await client.query<Target>(TARGETS_SQL, [
    lat,
    lng,
    input.radiusKm,
    input.requestedGrade ?? null,
  ]);
  const event = targets.length > 0 ? 'CREATE_WITH_TARGETS' : 'CREATE_NO_TARGET';
  // 위에서 진행 중 건을 끝냈으니 다른 진행 중 건은 없다. 그래도 전이 함수가 한 번 더 확인한다
  const { to, history } = transitionTransport(null, event, {
    now,
    version: 1,
    teamHasOtherActive: false,
  });

  // 요청 반경과 예비 추천 반경은 따로 저장한다. 처음에는 같은 값으로 시작 (SFR-012)
  await client.query(
    `INSERT INTO transport (id, team_id, status, request_radius_km, fallback_radius_km, requested_grade,
                            origin_lat, origin_lng, location_consent, address, fallback_reason)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      teamId,
      to,
      input.radiusKm,
      input.requestedGrade ?? null,
      lat,
      lng,
      input.locationConsent,
      input.address ?? null,
      to === 'fallback' ? history.reason : null,
    ],
  );
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.id, history.from, history.to, history.event, history.reason, history.at],
  );

  // 병원에 보낸 환자 평가 1번째 (보낼 때마다 1행). 요청을 못 보냈어도 예비 흐름 기록용으로 남긴다
  const a = input.assessment;
  await client.query(
    `INSERT INTO assessment (transport_id, seq, chief_complaint, sex, age_band, consciousness, bp, pulse,
                             resp, spo2, pain_site, pain_score, onset, trauma, trauma_cause, history, temp,
                             glucose, ktas, unknown_fields)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      input.id,
      a.chiefComplaint?.trim(),
      a.sex ?? null,
      a.ageBand ?? null,
      a.consciousness ?? null,
      a.bp ?? null,
      a.pulse ?? null,
      a.resp ?? null,
      a.spo2 ?? null,
      a.painSite ?? null,
      a.painScore ?? null,
      a.onset ?? null,
      a.trauma ?? null,
      a.traumaCause ?? null,
      a.history ?? null,
      a.temp ?? null,
      a.glucose ?? null,
      a.ktas ?? null,
      a.unknownFields ?? [],
    ],
  );

  // 팀원 화면에 'OOO 님이 요청했어요'. 대원 이름이라 환자 정보가 아니다 (DAR-013: 누가 보냈는지는 실시간 이벤트에만)
  const { rows: me } = await client.query<{ name: string }>(
    'SELECT name FROM paramedic WHERE id = $1',
    [paramedicId],
  );
  events.push({
    room: '',
    name: 'transport.created',
    entityType: 'transport',
    entityId: input.id,
    entityVersion: 1,
    payload: {
      transportId: input.id,
      status: to,
      byName: me[0].name,
      fallbackReason: to === 'fallback' ? history.reason : null,
    },
  });

  let roundId: string | null = null;
  if (to === 'requesting') {
    // 회차 1: 2분 응답 제한·5분 승인 유효는 DB 시각 기준으로 고정한다 (절대 규칙 6)
    const { rows: round } = await client.query<{
      id: string;
      respond_until: Date;
      approval_valid_until: Date;
    }>(
      `INSERT INTO request_round (transport_id, round_no, kind, radius_km, sent_at, respond_until, approval_valid_until)
       VALUES ($1, 1, 'first', $2, now(), now() + interval '2 minutes', now() + interval '5 minutes')
       RETURNING id, respond_until, approval_valid_until`,
      [input.id, input.radiusKm],
    );
    roundId = round[0].id;
    for (const target of targets) {
      const { to: hreqStatus } = transitionHreq(null, 'SEND', { now, version: 1 });
      await client.query(
        `INSERT INTO hospital_request (round_id, hospital_id, status, eta_min, eta_source)
         VALUES ($1, $2, $3, $4, 'straight')`,
        [
          round[0].id,
          target.id,
          hreqStatus,
          Math.max(1, Math.ceil((target.km / STRAIGHT_KMH) * 60)),
        ],
      );
    }
    events.push({
      room: '',
      name: 'round.started',
      entityType: 'transport',
      entityId: input.id,
      entityVersion: 1,
      payload: {
        transportId: input.id,
        roundNo: 1,
        kind: 'first',
        radiusKm: input.radiusKm,
        targetCount: targets.length,
        respondUntil: round[0].respond_until.toISOString(),
        approvalValidUntil: round[0].approval_valid_until.toISOString(),
      },
    });
  }

  const logged = await appendEvents(
    client,
    events.map((e) => ({ ...e, room: `team:${teamId}` })),
  );
  return { transportId: input.id, events: logged, roundId };
}

export function transportRouter(
  pool: pg.Pool,
  guards: RequestHandler[],
  realtime?: Realtime,
): Router {
  const router = Router();

  router.post('/transports', ...guards, async (req, res) => {
    const input = parseBody(createSchema, req.body);
    // 주 증상은 병원이 받아 볼 최소 정보라 비어 있으면 보내지 않는다 (SFR-108)
    if (!input.assessment.chiefComplaint?.trim()) {
      throw new AppError(422, 'ASSESSMENT_INCOMPLETE', '주 증상을 입력해 주세요', {
        fields: ['assessment.chiefComplaint'],
      });
    }
    const { paramedicId } = paramedicAuth(res);
    const outcome = await withTransaction(pool, (client) =>
      createTransport(client, paramedicId, input),
    );
    // 커밋된 뒤에만 보낸다. 팀원 화면 갱신 + 병원 PC에 request.new (SFR-109·161)
    realtime?.publish(outcome.events);
    if (outcome.roundId) realtime?.deliverRound(outcome.roundId);
    res.status(201).json(await loadTransport(pool, outcome.transportId, paramedicId));
  });

  router.get('/transports/current', ...guards, async (_req, res) => {
    const { paramedicId } = paramedicAuth(res);
    const noActive = new AppError(404, 'NO_ACTIVE_TRANSPORT', '진행 중 이송이 없어요');
    const teamId = await currentTeamId(pool, paramedicId);
    if (!teamId) throw noActive;
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM transport WHERE team_id = $1 AND status = ANY($2::transport_status[])',
      [teamId, ACTIVE],
    );
    if (!rows[0]) throw noActive;
    res.json(await loadTransport(pool, rows[0].id, paramedicId));
  });

  return router;
}
