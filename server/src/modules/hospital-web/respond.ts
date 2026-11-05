// 병원 웹 승인·거절·승인 취소 (SFR-119, SFR-128, SFR-140, SFR-153, SFR-154, SFR-160). 상태 변경은 stateMachine.ts 를 거친다 (절대 규칙 4).
// 이송 건 → 병원 요청 순서로 잠그고, 한 트랜잭션에서 병원 요청·제외 병원·이송 건(역방향 연쇄)·event_log 를 함께 바꾼다.
import type pg from 'pg';
import { z } from 'zod';
import {
  TransitionError,
  transitionHreq,
  transitionTransport,
  transportEventAfterHreqChange,
  type HreqEvent,
  type HreqStatus,
  type TransportStatus,
} from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { HospitalPc } from './pcAuth.js';

// version 이 빠지면 400 VERSION_REQUIRED 를 주려고 선택 칸으로 두고 상태 기계가 판정하게 한다
export const approveSchema = z.object({
  version: z.number().int().optional(),
  memo: z.string().trim().max(50).nullish(),
  overApprovalConfirmed: z.boolean().optional(),
});

// 사유가 빠지면 422 REASON_REQUIRED (상태 기계가 판정)
export const rejectSchema = z.object({
  version: z.number().int().optional(),
  reason: z
    .enum(['er_bed', 'or_room', 'ward', 'icu', 'no_specialist', 'equipment', 'etc'])
    .nullish(),
  etcText: z.string().trim().max(20).nullish(),
});

// 승인 취소도 거절과 같은 사유 7가지 (부록 G). 사유가 빠지면 422 REASON_REQUIRED
export const cancelApprovalSchema = rejectSchema;

export type ApproveInput = z.infer<typeof approveSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;

type Response =
  | { event: 'APPROVE'; input: ApproveInput }
  | { event: 'REJECT' | 'CANCEL_APPROVAL'; input: RejectInput };

export interface RespondResult {
  body: { status: HreqStatus; respondedBy?: string; version: number };
  events: LoggedEvent[];
}

interface Target {
  id: string;
  transport_id: string;
  hospital_id: string;
  hospital_name: string;
  round_no: number;
  round_id: string;
  is_current: boolean;
}

export async function respondToRequest(
  client: pg.PoolClient,
  pc: HospitalPc,
  requestId: number,
  response: Response,
): Promise<RespondResult> {
  // 다른 병원 요청은 있는지조차 알려 주지 않는다 (SER-013)
  const { rows: targets } = await client.query<Target>(
    `SELECT hr.id, r.transport_id, hr.hospital_id, h.name AS hospital_name, r.round_no, r.id AS round_id,
            r.round_no = (SELECT max(round_no) FROM request_round WHERE transport_id = r.transport_id) AS is_current
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       JOIN hospital h ON h.id = hr.hospital_id
      WHERE hr.id = $1`,
    [requestId],
  );
  const target = targets[0];
  if (!target || Number(target.hospital_id) !== pc.hospitalId) {
    throw new AppError(404, 'NOT_FOUND', '요청을 찾을 수 없어요');
  }

  // 누가 승인·거절했는지 남겨야 해서 근무 중인 PC 만 응답한다 (SFR-153)
  const { rows: shifts } = await client.query<{ staff_name: string }>(
    `SELECT staff_name FROM hospital_shift
      WHERE pc_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [pc.pcId],
  );
  if (!shifts[0]) throw new AppError(409, 'SHIFT_REQUIRED', '근무를 먼저 시작해 주세요');
  const staffName = shifts[0].staff_name;

  // 시간 판정은 DB 시각 (규칙 6). 2분 경계를 서버마다 다르게 보지 않는다
  const now = (await client.query<{ now: Date }>('SELECT now()')).rows[0].now;

  // 잠금 순서: 이송 건 먼저, 그다음 병원 요청 (stateMachine.ts 규칙 5, 5초 판정과 같은 순서 → 교착 없음)
  const { rows: transports } = await client.query<{
    status: TransportStatus;
    version: number;
    team_id: string | null;
  }>('SELECT status, version, team_id FROM transport WHERE id = $1 FOR UPDATE', [
    target.transport_id,
  ]);
  const transport = transports[0];
  // 두 PC 가 동시에 눌러도 여기서 한 줄로 선다. 먼저 온 쪽이 커밋하면 나중 쪽은 바뀐 version 을 읽는다
  const { rows: locked } = await client.query<{
    status: HreqStatus;
    version: number;
    responder_name: string | null;
    responder_pc_name: string | null;
    respond_until: Date;
  }>(
    `SELECT hr.status, hr.version, hr.responder_name, p.name AS responder_pc_name, r.respond_until
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
       LEFT JOIN hospital_pc p ON p.id = hr.responder_pc_id
      WHERE hr.id = $1
        FOR UPDATE OF hr`,
    [requestId],
  );
  const request = locked[0];

  // 과승인: 지금 유효한 우리 병원 승인 수가 응급실 가용 병상 이상이면 한 번 더 확인 (SFR-154)
  let overApproval = false;
  let validApprovals = 0;
  let erAvail: number | null = null;
  if (response.event === 'APPROVE') {
    const { rows } = await client.query<{ n: number; er_avail: number | null }>(
      `SELECT (SELECT count(*)::int FROM hospital_request hr
                 JOIN request_round r ON r.id = hr.round_id
                WHERE hr.hospital_id = $1 AND hr.status = 'approved' AND r.approval_valid_until > now()) AS n,
              (SELECT er_avail FROM bed_current WHERE hospital_id = $1) AS er_avail`,
      [pc.hospitalId],
    );
    validApprovals = rows[0].n;
    erAvail = rows[0].er_avail;
    // 병상 정보가 없으면 비교할 수 없어서 막지 않는다
    overApproval = erAvail !== null && validApprovals >= erAvail;
  }

  const reason = response.event === 'APPROVE' ? null : (response.input.reason ?? null);
  const etcText = response.event === 'APPROVE' ? null : response.input.etcText || null;
  let result;
  try {
    result = transitionHreq(request.status, response.event, {
      now,
      version: request.version,
      clientVersion: response.input.version,
      respondUntil: request.respond_until,
      // '기타'는 글까지 있어야 사유로 본다
      reason: reason === 'etc' && !etcText ? null : reason,
      overApproval,
      overApprovalConfirmed:
        response.event === 'APPROVE' ? response.input.overApprovalConfirmed : undefined,
    });
  } catch (err) {
    // 나중 PC 에게는 누가 먼저 응답했는지 알려 준다 (SFR-153)
    if (err instanceof TransitionError && err.code === 'ALREADY_RESPONDED') {
      throw new AppError(409, err.code, err.message, {
        respondedBy: request.responder_name,
        pcName: request.responder_pc_name,
        status: request.status,
        version: request.version,
      });
    }
    if (err instanceof TransitionError && err.code === 'OVER_APPROVAL_CONFIRM_REQUIRED') {
      throw new AppError(409, err.code, err.message, { validApprovals, erAvail });
    }
    throw err;
  }

  const cancelling = response.event === 'CANCEL_APPROVAL';
  // 승인 취소는 '누가 승인했는지'(응답자·메모)를 남겨 두고 닫힘 사유와 취소 사유만 적는다.
  // 취소한 사람 이름은 실시간 이벤트(byName)로 같은 병원 PC 에 알린다
  const { rows: updated } = await client.query<{ version: number }>(
    cancelling
      ? `UPDATE hospital_request
            SET status = $2, closed_reason = $3, reason = $4, reason_text = $5,
                version = version + 1, updated_at = now()
          WHERE id = $1
         RETURNING version`
      : `UPDATE hospital_request
            SET status = $2, responded_at = now(), responder_name = $3, responder_pc_id = $4,
                memo = $5, reason = $6, reason_text = $7, in_stats = $8,
                version = version + 1, updated_at = now()
          WHERE id = $1
         RETURNING version`,
    cancelling
      ? [requestId, result.to, result.closeReason, reason, reason === 'etc' ? etcText : null]
      : [
          requestId,
          result.to,
          staffName,
          pc.pcId,
          response.event === 'APPROVE' ? response.input.memo || null : null,
          reason,
          reason === 'etc' ? etcText : null,
          result.inStats,
        ],
  );
  const version = updated[0].version;
  const wasConfirmed = request.status === 'confirmed';
  // 병원 응답도 '활동'이다. 2시간 활동 없음 자동 종료의 시계를 다시 시작한다 (SFR-086)
  // version은 올리지 않는다: 이송 건 행의 상태가 바뀐 게 아니다 (stateMachine.ts 규칙 4)
  await client.query('UPDATE transport SET last_activity_at = now() WHERE id = $1', [
    target.transport_id,
  ]);

  // 거절·승인 취소한 병원은 이번 이송에서 다시 추천·요청하지 않는다 (SFR-086·119·128, '다시 요청'도 이 병원을 뺀다)
  if (response.event !== 'APPROVE') {
    await client.query(
      `INSERT INTO excluded_hospital (transport_id, hospital_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [target.transport_id, target.hospital_id, cancelling ? 'approval_cancelled' : 'rejected'],
    );
  }

  const events: EventRecord[] = [];
  const teamRoom = transport.team_id ? `team:${transport.team_id}` : null;

  // 이번 회차의 남은 대기·유효 승인 수 (첫 승인 알림과 역방향 연쇄에 쓴다)
  const { rows: counts } = await client.query<{ waiting: number; valid_approved: number }>(
    `SELECT count(*) FILTER (WHERE hr.status = 'waiting')::int AS waiting,
            count(*) FILTER (WHERE hr.status = 'approved' AND r.approval_valid_until > now())::int AS valid_approved
       FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
      WHERE hr.round_id = $1`,
    [target.round_id],
  );
  const roundCounts = { waiting: counts[0].waiting, validApproved: counts[0].valid_approved };

  if (teamRoom) {
    const common = {
      entityType: 'hospital_request',
      entityId: String(requestId),
      entityVersion: version,
    };
    events.push(
      cancelling
        ? {
            room: teamRoom,
            name: 'request.cancelled',
            ...common,
            payload: {
              transportId: target.transport_id,
              hospitalRequestId: requestId,
              hospitalName: target.hospital_name,
              reason: reason ?? '',
              // 확정(이동 중) 병원이 취소하면 앱이 경보 + '다시 요청' 버튼. 자동 재요청은 없다 (SFR-128)
              wasConfirmed,
            },
          }
        : response.event === 'APPROVE'
          ? {
              room: teamRoom,
              name: 'request.approved',
              ...common,
              payload: {
                transportId: target.transport_id,
                hospitalRequestId: requestId,
                hospitalId: pc.hospitalId,
                // 이번 회차에서 처음 온 승인이면 앱이 진동·소리 (SFR-110·130)
                firstApproval: roundCounts.validApproved === 1,
                afterReconnect: false,
              },
            }
          : {
              room: teamRoom,
              name: 'request.rejected',
              ...common,
              payload: {
                transportId: target.transport_id,
                hospitalRequestId: requestId,
                hospitalName: target.hospital_name,
                reason: reason ?? '',
              },
            },
    );
  }
  // 같은 병원 다른 PC 화면도 "박서연 님이 승인함"으로 바꾼다 (SFR-153). 이름·상태만, 환자 정보 없음 (규칙 5)
  events.push({
    room: `hospital:${pc.hospitalId}`,
    name: 'request.changed',
    entityType: 'hospital_request',
    entityId: String(requestId),
    entityVersion: version,
    payload: {
      requestId,
      status: result.to,
      closeReason: result.closeReason,
      byName: staffName,
      pcName: pc.pcName,
    },
  });
  // 확정 병원이 취소하면 도착 예정 목록에서도 빠진다 (SFR-121)
  if (wasConfirmed) {
    events.push({
      room: `hospital:${pc.hospitalId}`,
      name: 'incoming.removed',
      entityType: 'hospital_request',
      entityId: String(requestId),
      payload: { requestId, reason: 'approval_cancelled' },
    });
  }

  // 역방향 연쇄: 지금 회차에 대기·유효 승인이 하나도 안 남으면 이송 건을 예비 추천으로 (부록 A8·A10).
  // 확정 병원의 승인 취소는 회차와 상관없이 이동 중 이송 건에 경보 (A20, 상태는 moving 유지)
  if ((target.is_current || wasConfirmed) && transport) {
    const next = transportEventAfterHreqChange(
      transport.status,
      { event: response.event as HreqEvent, fromStatus: request.status },
      roundCounts,
    );
    if (next) {
      const { to, history } = transitionTransport(transport.status, next.event, {
        now,
        version: transport.version,
        fallbackReason: next.reason,
      });
      // '병원 응답 도착'처럼 상태가 그대로면 이송 건 행은 바꾸지 않는다 (version 은 행이 바뀔 때만 +1)
      if (to !== transport.status) {
        const { rows: moved } = await client.query<{ version: number }>(
          `UPDATE transport
              SET status = $2, version = version + 1,
                  fallback_reason = CASE WHEN $2::transport_status = 'fallback' THEN $3 ELSE fallback_reason END
            WHERE id = $1 RETURNING version`,
          [target.transport_id, to, history.reason],
        );
        await client.query(
          `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            target.transport_id,
            history.from,
            history.to,
            history.event,
            history.reason,
            history.at,
          ],
        );
        if (teamRoom) {
          events.push({
            room: teamRoom,
            name: 'transport.status',
            entityType: 'transport',
            entityId: target.transport_id,
            entityVersion: moved[0].version,
            payload: {
              transportId: target.transport_id,
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

  return {
    body:
      response.event === 'APPROVE'
        ? { status: result.to, respondedBy: staffName, version }
        : { status: result.to, version },
    events: await appendEvents(client, events),
  };
}
