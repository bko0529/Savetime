// 병원 잠시 요청 중지 (SFR-139). 한 PC에서 누르면 그 병원 전체가 요청 대상(SFR-109)에서 빠진다.
// 중지할 때 아직 응답하지 않은 대기 요청은 '거절(사유: 요청 중지)'로 한꺼번에 응답해 대원이 바로 다른 병원을 보게 한다.
// 상태 변경은 stateMachine.ts 의 PAUSE_AUTO_REJECT 를 거친다 (절대 규칙 4). 이미 승인한 요청은 그대로 둔다.
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  transitionHreq,
  transitionTransport,
  transportEventAfterHreqChange,
  type HreqStatus,
  type TransportStatus,
} from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import { recordRejection } from '../stats/records.js';
import type { HospitalPc } from './pcAuth.js';

export const pauseSchema = z.object({ paused: z.boolean() });

export interface PauseResult {
  events: LoggedEvent[];
  rejectedCount: number;
}

export async function setPaused(
  client: pg.PoolClient,
  pc: HospitalPc,
  paused: boolean,
): Promise<PauseResult> {
  // 누가 멈췄는지 남겨야 해서 근무 중인 PC 만 누른다
  const { rows: shifts } = await client.query<{ staff_name: string }>(
    `SELECT staff_name FROM hospital_shift
      WHERE pc_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [pc.pcId],
  );
  if (!shifts[0]) throw new AppError(409, 'SHIFT_REQUIRED', '근무를 먼저 시작해 주세요');
  const staffName = shifts[0].staff_name;

  // 병원 행을 먼저 잠근다: 두 PC 가 동시에 눌러도 한 줄로 서서, 나중 PC 는 바뀐 값을 본다
  const { rows: hospitals } = await client.query<{ requests_paused: boolean }>(
    'SELECT requests_paused FROM hospital WHERE id = $1 FOR UPDATE',
    [pc.hospitalId],
  );
  // 이미 그 상태면 아무것도 하지 않는다 (두 번 눌러도 안전)
  if (hospitals[0].requests_paused === paused) return { events: [], rejectedCount: 0 };

  // 중지 시각은 DB now() (규칙 6). 2시간 알림이 이 값으로 판정한다
  const { rows: updated } = await client.query<{ paused_at: Date | null; now: Date }>(
    `UPDATE hospital SET requests_paused = $2, paused_at = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE id = $1 RETURNING paused_at, now() AS now`,
    [pc.hospitalId, paused],
  );
  const { paused_at: pausedAt, now } = updated[0];

  const events: EventRecord[] = [];
  let rejectedCount = 0;
  if (paused) {
    // 아직 2분이 안 지난 대기 요청만. 2분이 지난 건 만료 타이머가 '만료'로 처리한다
    const { rows: waiting } = await client.query<{ id: string; transport_id: string }>(
      `SELECT hr.id, r.transport_id
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE hr.hospital_id = $1 AND hr.status = 'waiting' AND r.respond_until > now()
        ORDER BY hr.id`,
      [pc.hospitalId],
    );
    for (const w of waiting) {
      const done = await autoReject(client, Number(w.id), w.transport_id, now);
      if (done) {
        rejectedCount += 1;
        events.push(...done);
      }
    }
  }

  // 같은 병원 모든 PC 의 상단 표시를 같게 (실시간 설계 4-2). PC 이름·시각만
  events.push({
    room: `hospital:${pc.hospitalId}`,
    name: 'hospital.pause_changed',
    entityType: 'hospital',
    entityId: String(pc.hospitalId),
    payload: {
      paused,
      byPcName: pc.pcName,
      byName: staffName,
      pausedAt: pausedAt?.toISOString() ?? null,
    },
  });
  return { events: await appendEvents(client, events), rejectedCount };
}

// 대기 요청 1건을 '거절(요청 중지)'로. 잠금 순서는 다른 곳과 같게 이송 건 → 병원 요청 (교착 방지)
async function autoReject(
  client: pg.PoolClient,
  requestId: number,
  transportId: string,
  now: Date,
): Promise<EventRecord[] | null> {
  const { rows: transports } = await client.query<{
    status: TransportStatus;
    version: number;
    team_id: string | null;
  }>('SELECT status, version, team_id FROM transport WHERE id = $1 FOR UPDATE', [transportId]);
  const transport = transports[0];
  const { rows: locked } = await client.query<{
    status: HreqStatus;
    round_id: string;
    hospital_id: string;
    hospital_name: string;
    is_current: boolean;
  }>(
    `SELECT hr.status, hr.round_id, hr.hospital_id, h.name AS hospital_name,
            r.round_no = (SELECT max(round_no) FROM request_round WHERE transport_id = r.transport_id) AS is_current
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       JOIN hospital h ON h.id = hr.hospital_id
      WHERE hr.id = $1
        FOR UPDATE OF hr`,
    [requestId],
  );
  const request = locked[0];
  // 잠그는 사이 다른 PC 가 응답했으면 건드리지 않는다
  if (request.status !== 'waiting') return null;

  // 시스템 사건이라 version 비교는 없다. 통계 제외·제외 병원 아님은 상태 전이표가 정한다 (부록 A-2 38)
  const result = transitionHreq(request.status, 'PAUSE_AUTO_REJECT', {
    now,
    version: 0,
  });
  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE hospital_request
        SET status = $2, responded_at = now(), reason = 'paused', in_stats = $3,
            version = version + 1, updated_at = now()
      WHERE id = $1
     RETURNING version`,
    [requestId, result.to, result.inStats],
  );
  const version = updated[0].version;
  // 요청 중지 자동 거절도 통계 원장에 남긴다. 출처가 'paused' 라 병원 거절 기본 수치에는 안 들어간다 (SFR-126)
  await recordRejection(client, {
    transportId,
    hospitalId: request.hospital_id,
    source: 'paused',
    reason: 'paused',
    reasonText: null,
  });
  // 병원 응답도 '활동'이다 (SFR-086). 이송 건 상태는 그대로라 version 은 안 올린다
  await client.query('UPDATE transport SET last_activity_at = now() WHERE id = $1', [transportId]);

  const events: EventRecord[] = [];
  const teamRoom = transport.team_id ? `team:${transport.team_id}` : null;
  const common = {
    entityType: 'hospital_request',
    entityId: String(requestId),
    entityVersion: version,
  };
  if (teamRoom) {
    // 대원 앱에 바로 '거절 · 요청 중지' (인수 기준 2)
    events.push({
      room: teamRoom,
      name: 'request.rejected',
      ...common,
      payload: {
        transportId,
        hospitalRequestId: requestId,
        hospitalName: request.hospital_name,
        reason: 'paused',
      },
    });
  }

  // 역방향 연쇄: 지금 회차에 대기·유효 승인이 하나도 안 남으면 이송 건을 예비 추천으로 (부록 A8)
  if (request.is_current && transport) {
    const { rows: counts } = await client.query<{ waiting: number; valid_approved: number }>(
      `SELECT count(*) FILTER (WHERE hr.status = 'waiting')::int AS waiting,
              count(*) FILTER (WHERE hr.status = 'approved' AND r.approval_valid_until > now())::int AS valid_approved
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE hr.round_id = $1`,
      [request.round_id],
    );
    const next = transportEventAfterHreqChange(
      transport.status,
      { event: 'PAUSE_AUTO_REJECT', fromStatus: request.status },
      { waiting: counts[0].waiting, validApproved: counts[0].valid_approved },
    );
    if (next) {
      const { to, history } = transitionTransport(transport.status, next.event, {
        now,
        version: transport.version,
        fallbackReason: next.reason,
      });
      if (to !== transport.status) {
        const { rows: moved } = await client.query<{ version: number }>(
          `UPDATE transport
              SET status = $2, version = version + 1,
                  fallback_reason = CASE WHEN $2::transport_status = 'fallback' THEN $3 ELSE fallback_reason END
            WHERE id = $1 RETURNING version`,
          [transportId, to, history.reason],
        );
        await client.query(
          `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [transportId, history.from, history.to, history.event, history.reason, history.at],
        );
        if (teamRoom) {
          events.push({
            room: teamRoom,
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
        }
      }
    }
  }
  return events;
}

// 중지 2시간째 알림 (SFR-139). 1분마다 훑고, 같은 중지에 대해서는 한 번만 보낸다.
// '보냈음' 표시는 Redis 에 병원+중지 시각으로 남긴다 (서버 2대여도 한 번, 다시 중지하면 새로 센다. 규칙 7)
export const PAUSE_REMIND_EVERY_MS = 60_000;
export const PAUSE_REMIND_AFTER = '2 hours';
const REMINDED_TTL_SECONDS = 3 * 24 * 60 * 60;
const remindedKey = (hospitalId: string, pausedAt: Date) =>
  `hw:pause-reminded:${hospitalId}:${pausedAt.getTime()}`;

export async function remindLongPauses(
  pool: pg.Pool,
  redis: Redis,
  logger: Logger,
  after = PAUSE_REMIND_AFTER,
): Promise<LoggedEvent[]> {
  // 시간 판정은 DB now() (규칙 6)
  const { rows } = await pool.query<{ id: string; paused_at: Date }>(
    `SELECT id, paused_at FROM hospital
      WHERE requests_paused AND paused_at <= now() - $1::interval`,
    [after],
  );
  const events: EventRecord[] = [];
  for (const h of rows) {
    try {
      const first = await redis.set(
        remindedKey(h.id, h.paused_at),
        '1',
        'EX',
        REMINDED_TTL_SECONDS,
        'NX',
      );
      if (first !== 'OK') continue;
      events.push({
        room: `hospital:${h.id}`,
        name: 'hospital.pause_reminder',
        entityType: 'hospital',
        entityId: h.id,
        payload: { pausedAt: h.paused_at.toISOString() },
      });
    } catch (err) {
      logger.error({ message: (err as Error).message, hospitalId: h.id }, '요청 중지 알림 실패');
    }
  }
  if (events.length === 0) return [];
  // event_log 에 남겨 두면 놓친 PC 도 다시 받기로 볼 수 있다
  const client = await pool.connect();
  try {
    return await appendEvents(client, events);
  } finally {
    client.release();
  }
}
