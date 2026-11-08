// 목적지 변경 (SFR-077, 부록 A21 · A-2 45, 사건 CHANGE_DESTINATION). 이송 건당 1번, 사유 필수.
// 새 병원을 고르는 API가 아니다: 이전 목적지를 닫고(dest_changed)·제외 병원에 넣은 뒤, 지금 위치 기준 반경 안 병원에 새 회차를 보낸다.
// 상태 변경은 stateMachine.ts 전이 함수만 거친다 (절대 규칙 4). 잠금 순서는 이송 건 → 병원 요청 (stateMachine.ts 규칙 5)
import type pg from 'pg';
import { z } from 'zod';
import { isInKorea } from '../../domain/geo.js';
import {
  CASCADE,
  transitionHreq,
  transitionTransport,
  type DestChangeReason,
  type HreqStatus,
} from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import { lockMyTransport } from './access.js';
import { findRequestTargets, insertRound } from './requestTargets.js';
import { loadTransport } from './view.js';

// 사유·버전이 빠지면 상태 전이 함수가 REASON_REQUIRED·VERSION_REQUIRED 로 판정하게 선택 칸으로 둔다
export const destinationSchema = z.object({
  reason: z.enum(['patient_change', 'road', 'hospital', 'etc']).nullish(),
  version: z.number().int().optional(),
  // 지금 위치. 없으면 출발 위치 기준 (위치 미동의 건 등)
  location: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
});

export interface DestinationInput {
  transportId: string;
  paramedicId: string;
  reason?: DestChangeReason | null;
  location?: { lat: number; lng: number } | null;
  clientVersion?: number;
}

export interface DestinationOutcome {
  body: unknown;
  events: LoggedEvent[];
  roundId: string;
}

export async function changeDestination(
  client: pg.PoolClient,
  input: DestinationInput,
): Promise<DestinationOutcome> {
  const { transportId } = input;
  // 팀원 둘이 같이 눌러도 이송 건 행에서 한 줄로 선다. 나중 쪽은 바뀐 version 을 보고 409
  const transport = await lockMyTransport(client, transportId, input.paramedicId);
  // 시간 판정·기록은 DB 시각 (절대 규칙 6)
  const now = (await client.query<{ now: Date }>('SELECT now()')).rows[0].now;

  const { rows } = await client.query<{
    origin_lat: number | null;
    origin_lng: number | null;
    request_radius_km: number;
    requested_grade: number | null;
    confirmed_hospital_id: string | null;
    dest_changed_at: Date | null;
  }>(
    `SELECT origin_lat::float8 AS origin_lat, origin_lng::float8 AS origin_lng, request_radius_km,
            requested_grade, confirmed_hospital_id, dest_changed_at
       FROM transport WHERE id = $1`,
    [transportId],
  );
  const t = rows[0];

  // 지금 위치(앱이 보냄) 기준. 출발 좌표는 이송이 끝날 때까지 남아 있어서 없을 때 대신 쓴다
  const at = input.location
    ? input.location
    : t.origin_lat !== null && t.origin_lng !== null
      ? { lat: t.origin_lat, lng: t.origin_lng }
      : null;
  if (!at) throw new AppError(409, 'LOCATION_REQUIRED', '지금 위치를 알 수 없어요');
  if (!isInKorea(at.lat, at.lng)) {
    throw new AppError(400, 'VALIDATION_FAILED', '좌표 범위 오류: 대한민국 밖 좌표예요', {
      fields: ['location'],
      reason: 'coords_out_of_korea',
    });
  }

  // 새 요청 대상: 지금 반경·고른 등급 그대로, 제외 병원과 지금 목적지는 뺀다.
  // 지금 목적지는 아래에서 제외 병원에 넣지만, 대상은 그 전에 세야 '0곳'을 상태 기계가 먼저 판정할 수 있다
  const targets = (
    await findRequestTargets(client, {
      lat: at.lat,
      lng: at.lng,
      radiusKm: t.request_radius_km,
      grade: t.requested_grade,
      transport: { id: transportId, skipAlreadyRequested: false },
    })
  ).filter((target) => target.id !== t.confirmed_hospital_id);

  // 표(이동 중만) → 1번만 → 사유 → 대상 0곳 → 버전 순서로 판정. 실패하면 아무것도 안 바뀐다
  const { to, history } = transitionTransport(transport.status, 'CHANGE_DESTINATION', {
    now,
    version: transport.version,
    clientVersion: input.clientVersion,
    destinationChangedBefore: t.dest_changed_at !== null,
    destReason: input.reason ?? null,
    newTargetCount: targets.length,
  });

  // 이전 목적지·사유·시각을 남긴다. 출발 시각·경로 안내 담당 단말은 그대로 → 경로 안내·위치 기록이 이어지고
  // 소요시간은 처음 출발 시각부터 잰다 (SFR-036·039). 확정 병원은 비운다: 새 회차에서 다시 고른다
  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE transport
        SET status = $2, dest_changed_at = now(), dest_changed_from_hospital_id = confirmed_hospital_id,
            dest_change_reason = $3, confirmed_hospital_id = NULL, last_activity_at = now(),
            version = version + 1
      WHERE id = $1 RETURNING version`,
    [transportId, to, input.reason],
  );
  const version = updated[0].version;
  await client.query(
    `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transportId, history.from, history.to, history.event, history.reason, history.at],
  );

  const events: EventRecord[] = [];
  // 연쇄 1: 확정 병원 요청 → 닫힘(목적지 변경). 병원 웹에 '목적지 변경'이 보이고 도착 예정 목록에서 빠진다 (A-2 45)
  const closeStep = CASCADE.CHANGE_DESTINATION?.find((step) => step.target === 'confirmed');
  if (closeStep) {
    const { rows: confirmed } = await client.query<{
      id: string;
      hospital_id: string;
      status: HreqStatus;
      version: number;
    }>(
      `SELECT hr.id, hr.hospital_id, hr.status, hr.version
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $1 AND hr.status = 'confirmed'
        ORDER BY hr.id
          FOR UPDATE OF hr`,
      [transportId],
    );
    for (const request of confirmed) {
      const result = transitionHreq(request.status, closeStep.event, {
        now,
        version: request.version,
      });
      const { rows: closed } = await client.query<{ version: number }>(
        `UPDATE hospital_request
            SET status = $2, closed_reason = $3, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [request.id, result.to, result.closeReason],
      );
      const room = `hospital:${request.hospital_id}`;
      events.push(
        {
          room,
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
        },
        {
          room,
          name: 'incoming.removed',
          entityType: 'hospital_request',
          entityId: request.id,
          payload: { requestId: Number(request.id), reason: 'dest_changed' },
        },
      );
    }
  }

  // 이전 목적지는 이번 이송에서 다시 추천·요청하지 않는다 (SFR-086). 전화로 확정한 병원(요청 행 없음)도 같다
  if (t.confirmed_hospital_id) {
    await client.query(
      `INSERT INTO excluded_hospital (transport_id, hospital_id, reason) VALUES ($1, $2, 'dest_changed')
       ON CONFLICT DO NOTHING`,
      [transportId, t.confirmed_hospital_id],
    );
  }

  // 연쇄 2: 새 회차(dest_change). 이송 생성·다시 요청과 같은 함수라 2분·5분 기준도 같다
  const round = await insertRound(client, {
    transportId,
    kind: 'dest_change',
    radiusKm: t.request_radius_km,
    targets,
    now,
    entityVersion: version,
  });

  const teamRoom = `team:${transport.team_id}`;
  events.push(
    {
      room: teamRoom,
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
    { ...round.event, room: teamRoom },
  );

  return {
    body: await loadTransport(client, transportId, input.paramedicId),
    events: await appendEvents(client, events),
    roundId: round.roundId,
  };
}
