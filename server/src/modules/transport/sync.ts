// 통신 두절 중 기록 올리기 (SFR-099·068·160, 부록 A30). 복구되면 앱이 단말에 보관한 기록을 발생 순서대로 올린다.
// - 보관할 수 있는 건 3가지뿐: 오프라인 예비 추천 건(create_fallback) · 전화 확인 결과(phone_check) · 도착(arrive).
//   확정·취소·목적지 변경·병원 요청은 오프라인에서 막는다 (stateMachine.ts OFFLINE_QUEUEABLE)
// - 기록마다 트랜잭션을 따로 쓴다. 한 건이 실패해도 앞에서 반영된 건은 남는다
// - 상태 변경은 온라인 API 와 같은 함수(전화 확인·도착)를 그대로 불러 stateMachine.ts 를 거친다 (절대 규칙 4).
//   버전은 서버가 판정한다: 단말은 그동안 서버 변화를 못 봤으니, 아래 '충돌 규칙'으로 반영 여부를 정하고 현재 버전으로 적용한다
// - 충돌 규칙 (SFR-099, SFR-160 의 예외): 서버의 그 이송 건에 유효한 승인(5분 안)이나 확정(이동 중)이 생겼으면
//   오프라인 전화 결과는 반영하지 않고 이력으로만 남긴다(history_only) + 경보. 앱은 서버 상태를 보여 준다
// - 시간 판정은 DB now() (규칙 6). 기록에 남기는 시각만 단말 시각을 쓰되, 이송 건 생성~지금 사이로 맞춘다 (단말 시계 오차)
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { isInKorea, RADIUS_KM } from '../../domain/geo.js';
import { ACTIVE, TransitionError, transitionTransport } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { syncTeamDraft } from '../team/draft.js';
import { currentTeamId } from '../team/routes.js';
import { lockMyTransport } from './access.js';
import {
  ASSESSMENT_COLUMN,
  ASSESSMENT_FIELDS,
  assessmentSchema,
  assessmentValues,
  cleanAssessment,
} from './assessment.js';
import { arriveTransport } from './finish.js';
import { recordPhoneResult, startPhoneCheck } from './phoneCheck.js';
import { loadTransport } from './view.js';

const base = {
  clientRecordId: z.uuid(),
  transportId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
};
const radius = z
  .number()
  .int()
  .refine((v) => (RADIUS_KM as readonly number[]).includes(v));

const recordSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('create_fallback'),
    assessment: assessmentSchema,
    radiusKm: radius,
    location: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('phone_check'),
    hospitalId: z.number().int().positive(),
    result: z.enum(['accepted', 'no_answer', 'skipped', 'rejected', 'dismissed']),
    reason: z.enum(['no_answer', 'busy', 'urgent', 'etc']).nullish(),
    reasonText: z.string().trim().max(30).nullish(),
    rejectReason: z
      .enum(['er_bed', 'or_room', 'ward', 'icu', 'no_specialist', 'equipment', 'etc'])
      .nullish(),
  }),
  z.object({
    ...base,
    kind: z.literal('arrive'),
    method: z.enum(['button', 'menu']),
  }),
]);
const syncSchema = z.object({ records: z.array(recordSchema).min(1).max(100) });
type SyncRecord = z.infer<typeof recordSchema>;

export type SyncOutcome = 'applied' | 'history_only' | 'duplicate' | 'rejected';
interface RecordResult {
  clientRecordId: string;
  outcome: SyncOutcome;
  code: string | null;
}
interface Applied {
  outcome: Exclude<SyncOutcome, 'rejected'>;
  events: LoggedEvent[];
}

// 단말 시각을 '이송 건 생성 ~ 지금' 사이로 맞춘다 (DB 시각 기준)
async function clampedAt(client: pg.PoolClient, transportId: string, at: string): Promise<Date> {
  const { rows } = await client.query<{ at: Date }>(
    `SELECT LEAST(now(), GREATEST(created_at, $2::timestamptz)) AS at FROM transport WHERE id = $1`,
    [transportId, at],
  );
  return rows[0].at;
}

// 오프라인 예비 추천 건 등록 (A5 CREATE_NO_TARGET, 사유 offline). 병원에는 요청을 보내지 않는다 (요청은 보관·지연 전송 안 함)
async function applyCreate(
  client: pg.PoolClient,
  paramedicId: string,
  r: Extract<SyncRecord, { kind: 'create_fallback' }>,
): Promise<Applied> {
  const teamId = await currentTeamId(client, paramedicId);
  if (!teamId) throw new AppError(404, 'NOT_IN_TEAM', '근무 중인 팀이 없어요');
  // 팀 행을 잠가 '병원에 요청'·다른 오프라인 등록과 한 줄로 선다 (SFR-104)
  await client.query('SELECT id FROM team WHERE id = $1 FOR UPDATE', [teamId]);

  // 같은 ID 가 이미 있으면 다시 올린 것
  const { rows: same } = await client.query<{ team_id: string | null }>(
    'SELECT team_id FROM transport WHERE id = $1',
    [r.transportId],
  );
  if (same[0]) {
    if (same[0].team_id !== teamId)
      throw new AppError(404, 'NOT_FOUND', '이송 건을 찾을 수 없어요');
    return { outcome: 'duplicate', events: [] };
  }
  if (r.location && !isInKorea(r.location.lat, r.location.lng)) {
    throw new AppError(400, 'VALIDATION_FAILED', '좌표 범위 오류: 대한민국 밖 좌표예요', {
      fields: ['location'],
    });
  }
  const { rows: active } = await client.query(
    'SELECT 1 FROM transport WHERE team_id = $1 AND status = ANY($2::transport_status[])',
    [teamId, ACTIVE],
  );
  const now = (await client.query<{ now: Date }>('SELECT now()')).rows[0].now;
  const created = transitionTransport(null, 'CREATE_NO_TARGET', {
    now,
    version: 1,
    teamHasOtherActive: false,
    fallbackReason: 'offline',
  });
  // 같은 팀에 다른 진행 중 건이 있으면: 서버 건을 남기고 오프라인 건은 바로 이력으로 (offline_superseded, A30).
  // 팀당 진행 중 건은 1개(DB 규칙)라, 예비 추천으로 넣었다 취소하지 않고 두 전이를 판정한 뒤 '취소됨'으로 넣는다
  const superseded = active[0]
    ? transitionTransport(created.to, 'CANCEL', {
        now,
        version: 1,
        cancelReason: 'offline_superseded',
      })
    : null;
  const status = superseded ? superseded.to : created.to;
  // 만든 시각 = 단말 시각(지금보다 뒤면 지금). 오프라인 건은 서버에 늦게 도착한다.
  // 이력으로 돌린 건은 출발 좌표를 남기지 않는다 (끝난 건, SER-002)
  await client.query(
    `INSERT INTO transport (id, team_id, status, request_radius_km, fallback_radius_km, origin_lat, origin_lng,
                            location_consent, fallback_reason, offline_created, created_at,
                            cancelled_at, cancel_reason)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, true, LEAST(now(), $9::timestamptz),
             CASE WHEN $10::text IS NULL THEN NULL ELSE now() END, $10)`,
    [
      r.transportId,
      teamId,
      status,
      r.radiusKm,
      superseded ? null : (r.location?.lat ?? null),
      superseded ? null : (r.location?.lng ?? null),
      Boolean(r.location),
      created.history.reason,
      r.occurredAt,
      superseded ? 'offline_superseded' : null,
    ],
  );
  for (const h of superseded ? [created.history, superseded.history] : [created.history]) {
    await client.query(
      `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.transportId, h.from, h.to, h.event, h.reason, h.at],
    );
  }
  const columns = ASSESSMENT_FIELDS.map((f) => ASSESSMENT_COLUMN[f]);
  await client.query(
    `INSERT INTO assessment (transport_id, seq, ${columns.join(', ')})
     VALUES ($1, 1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})`,
    [r.transportId, ...assessmentValues(r.assessment)],
  );

  const { rows: me } = await client.query<{ name: string }>(
    'SELECT name FROM paramedic WHERE id = $1',
    [paramedicId],
  );
  // 이력으로 돌린 건은 팀 화면에 알리지 않는다 (앱은 응답의 alert 로 서버 건을 보여 준다)
  if (superseded) return { outcome: 'history_only', events: [] };
  const events: EventRecord[] = [
    {
      room: `team:${teamId}`,
      name: 'transport.created',
      entityType: 'transport',
      entityId: r.transportId,
      entityVersion: 1,
      payload: {
        transportId: r.transportId,
        status: created.to,
        byName: me[0].name,
        fallbackReason: 'offline',
      },
    },
    // 팀 작성 중 정보 = 이 환자 정보. '변경 사항 보내기(n)'가 0에서 시작 (SFR-105)
    await syncTeamDraft(client, {
      teamId,
      paramedicId,
      byName: me[0].name,
      data: cleanAssessment(r.assessment),
    }),
  ];
  return { outcome: 'applied', events: await appendEvents(client, events) };
}

// 서버의 그 이송 건에 유효한 승인이나 확정이 있나 (있으면 오프라인 전화 결과는 이력으로만)
async function serverHasApprovalOrConfirm(client: pg.PoolClient, transportId: string) {
  const { rows } = await client.query<{ yes: boolean }>(
    `SELECT t.status = 'moving'
            OR EXISTS (SELECT 1 FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
                        WHERE r.transport_id = t.id
                          AND (hr.status = 'confirmed'
                               OR (hr.status = 'approved' AND r.approval_valid_until > now()))) AS yes
       FROM transport t WHERE t.id = $1`,
    [transportId],
  );
  return rows[0].yes;
}

async function applyPhone(
  client: pg.PoolClient,
  paramedicId: string,
  r: Extract<SyncRecord, { kind: 'phone_check' }>,
): Promise<Applied> {
  const { rows: dup } = await client.query(
    'SELECT 1 FROM phone_check WHERE client_record_id = $1',
    [r.clientRecordId],
  );
  if (dup[0]) return { outcome: 'duplicate', events: [] };

  const transport = await lockMyTransport(client, r.transportId, paramedicId);
  const at = await clampedAt(client, r.transportId, r.occurredAt);
  const offline = { clientRecordId: r.clientRecordId, at };

  if (
    !ACTIVE.includes(transport.status) ||
    (await serverHasApprovalOrConfirm(client, r.transportId))
  ) {
    // 이력으로만: 결과·시각만 남기고 상태·제외 병원은 바꾸지 않는다
    await client.query(
      `INSERT INTO phone_check (transport_id, hospital_id, result, reason, reject_reason, reason_text,
                                created_at, offline, client_record_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
      [
        r.transportId,
        r.hospitalId,
        r.result,
        r.result === 'no_answer' || r.result === 'skipped' ? (r.reason ?? null) : null,
        r.result === 'rejected' ? (r.rejectReason ?? null) : null,
        r.reasonText ?? null,
        at,
        r.clientRecordId,
      ],
    );
    return { outcome: 'history_only', events: [] };
  }

  const events: LoggedEvent[] = [];
  // 단말은 오프라인에서 이 병원으로 전화 확인을 시작했다. 서버가 아직 그 상태가 아니면 같은 흐름을 먼저 밟는다
  const { rows } = await client.query<{ phone_target_hospital_id: string | null; version: number }>(
    'SELECT phone_target_hospital_id, version FROM transport WHERE id = $1',
    [r.transportId],
  );
  if (transport.status !== 'phone_check') {
    const started = await startPhoneCheck(client, {
      transportId: r.transportId,
      paramedicId,
      hospitalId: r.hospitalId,
      clientVersion: rows[0].version,
    });
    events.push(...started.events);
  } else if (rows[0].phone_target_hospital_id !== String(r.hospitalId)) {
    // 오프라인에서 다른 병원으로 넘어갔다 (거절 뒤 다음 후보를 단말이 고름). 대상만 바꾼다
    const { rows: target } = await client.query<{ name: string; excluded: boolean }>(
      `SELECT h.name, EXISTS (SELECT 1 FROM excluded_hospital e
                               WHERE e.transport_id = $2 AND e.hospital_id = h.id) AS excluded
         FROM hospital h WHERE h.id = $1`,
      [r.hospitalId, r.transportId],
    );
    if (!target[0]) throw new AppError(404, 'NOT_FOUND', '병원을 찾을 수 없어요');
    if (target[0].excluded) {
      throw new AppError(400, 'VALIDATION_FAILED', '이번 이송에서 제외된 병원이에요', {
        fields: ['hospitalId'],
      });
    }
    const { rows: moved } = await client.query<{ version: number }>(
      `UPDATE transport SET phone_target_hospital_id = $2, version = version + 1 WHERE id = $1
       RETURNING version`,
      [r.transportId, r.hospitalId],
    );
    events.push(
      ...(await appendEvents(client, [
        {
          room: `team:${transport.team_id}`,
          name: 'transport.phone_target',
          entityType: 'transport',
          entityId: r.transportId,
          entityVersion: moved[0].version,
          payload: {
            transportId: r.transportId,
            hospitalId: r.hospitalId,
            hospitalName: target[0].name,
          },
        },
      ])),
    );
  }

  const { rows: now } = await client.query<{ version: number }>(
    'SELECT version FROM transport WHERE id = $1',
    [r.transportId],
  );
  const result = await recordPhoneResult(client, {
    transportId: r.transportId,
    paramedicId,
    hospitalId: r.hospitalId,
    result: r.result,
    reason: r.reason,
    reasonText: r.reasonText,
    rejectReason: r.rejectReason,
    clientVersion: now[0].version,
    offline,
  });
  events.push(...result.events);
  return { outcome: 'applied', events };
}

async function applyArrive(
  client: pg.PoolClient,
  paramedicId: string,
  r: Extract<SyncRecord, { kind: 'arrive' }>,
): Promise<Applied> {
  const transport = await lockMyTransport(client, r.transportId, paramedicId);
  if (transport.status === 'arrived') return { outcome: 'duplicate', events: [] };
  if (transport.status !== 'moving') {
    // 그사이 서버에서 목적지 변경·취소 등으로 상태가 달라졌다: 도착은 이력으로만 (A30)
    await client.query(
      `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
       VALUES ($1, $2, $2, 'ARRIVE', 'offline_history', $3)`,
      [r.transportId, transport.status, await clampedAt(client, r.transportId, r.occurredAt)],
    );
    return { outcome: 'history_only', events: [] };
  }
  const arrived = await arriveTransport(client, {
    transportId: r.transportId,
    paramedicId,
    method: r.method,
    clientVersion: transport.version,
    occurredAt: new Date(r.occurredAt),
  });
  return { outcome: 'applied', events: arrived.events };
}

export async function syncRecords(
  pool: pg.Pool,
  paramedicId: string,
  records: SyncRecord[],
  realtime?: Realtime,
) {
  const results: RecordResult[] = [];
  for (const r of records) {
    try {
      const applied = await withTransaction(pool, (client) =>
        r.kind === 'create_fallback'
          ? applyCreate(client, paramedicId, r)
          : r.kind === 'phone_check'
            ? applyPhone(client, paramedicId, r)
            : applyArrive(client, paramedicId, r),
      );
      // 커밋된 뒤에만 보낸다
      realtime?.publish(applied.events);
      results.push({ clientRecordId: r.clientRecordId, outcome: applied.outcome, code: null });
    } catch (err) {
      // 이 기록만 거절하고 다음 기록은 계속 올린다. 서버 내부 오류는 그대로 던진다
      if (err instanceof AppError || err instanceof TransitionError) {
        results.push({ clientRecordId: r.clientRecordId, outcome: 'rejected', code: err.code });
        continue;
      }
      throw err;
    }
  }
  // 반영 후 최신 상태: 마지막 기록의 이송 건 (복구 뒤 자동 재조회, SFR-068)
  const last = records[records.length - 1];
  const transport = (await loadTransport(pool, last.transportId, paramedicId)) ?? null;
  return {
    results,
    transport,
    // 이력으로만 남긴 기록이 있으면 경보 + 서버 상태 표시 (SFR-099)
    alert: results.some((r) => r.outcome === 'history_only'),
  };
}

export function syncRouter(pool: pg.Pool, guards: RequestHandler[], realtime?: Realtime): Router {
  const router = Router();
  router.post('/transports/sync', ...guards, async (req, res) => {
    const input = parseBody(syncSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    res.json(await syncRecords(pool, paramedicId, input.records, realtime));
  });
  return router;
}
