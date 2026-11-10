// 병원 웹 '수용 불가' (SFR-158, H-03). 도착 예정 목록에서 도착한 지 10분 안의 환자를 사유와 함께 '수용 불가'로 돌린다.
// - 상태 변경은 stateMachine.ts 를 거친다 (arrived → unacceptable, 10분·사유 판정, 절대 규칙 4)
// - 이송 건 → 병원 요청 순으로 잠그고 version 을 비교한다 (절대 규칙 8, 승인·거절과 같은 순서)
// - 대원 앱에 경보 transport.unacceptable (푸시 포함). 이 병원은 직전 건을 이어 쓰는 다음 이송에서
//   자동으로 빠진다 (team/prevPatient.ts 가 hospital_request.status = 'unacceptable' 을 본다)
// - 거절 원장에 출처 '수용 불가'로 1줄 (SFR-126) → 승인 취소율 통계(SFR-106)에 함께 센다
import type pg from 'pg';
import { z } from 'zod';
import { transitionHreq, type HreqStatus } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import { recordRejection } from '../stats/records.js';
import type { HospitalPc } from './pcAuth.js';

// 사유는 병원 웹 거절과 같은 7가지 (부록 G). 빠지면 422 REASON_REQUIRED, version 이 빠지면 400 VERSION_REQUIRED
export const unacceptableSchema = z.object({
  version: z.number().int().optional(),
  reason: z
    .enum(['er_bed', 'or_room', 'ward', 'icu', 'no_specialist', 'equipment', 'etc'])
    .nullish(),
  etcText: z.string().trim().max(20).nullish(),
});
export type UnacceptableInput = z.infer<typeof unacceptableSchema>;

export async function markUnacceptable(
  client: pg.PoolClient,
  pc: HospitalPc,
  requestId: number,
  input: UnacceptableInput,
): Promise<LoggedEvent[]> {
  // 다른 병원 요청은 있는지조차 알려 주지 않는다 (SER-013)
  const { rows: targets } = await client.query<{
    transport_id: string;
    hospital_id: string;
    hospital_name: string;
  }>(
    `SELECT r.transport_id, hr.hospital_id, h.name AS hospital_name
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

  // 누가 눌렀는지 남겨야 해서 근무 중인 PC 만 (승인·거절과 같음)
  const { rows: shifts } = await client.query<{ staff_name: string }>(
    `SELECT staff_name FROM hospital_shift
      WHERE pc_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [pc.pcId],
  );
  if (!shifts[0]) throw new AppError(409, 'SHIFT_REQUIRED', '근무를 먼저 시작해 주세요');

  // 10분 판정은 DB 시각 (규칙 6)
  const now = (await client.query<{ now: Date }>('SELECT now()')).rows[0].now;

  // 잠금 순서: 이송 건 먼저, 그다음 병원 요청 (교착 방지)
  const { rows: transports } = await client.query<{ team_id: string | null }>(
    'SELECT team_id FROM transport WHERE id = $1 FOR UPDATE',
    [target.transport_id],
  );
  const { rows: locked } = await client.query<{
    status: HreqStatus;
    version: number;
    arrived_at: Date | null;
  }>('SELECT status, version, arrived_at FROM hospital_request WHERE id = $1 FOR UPDATE', [
    requestId,
  ]);
  const request = locked[0];

  // 두 PC 가 동시에 눌러도 나중 쪽은 바뀐 version 을 보고 막힌다 (SFR-160). 명세대로 VERSION_CONFLICT
  if (input.version === undefined) {
    throw new AppError(400, 'VERSION_REQUIRED', 'version을 같이 보내야 해요');
  }
  if (input.version !== request.version) {
    throw new AppError(409, 'VERSION_CONFLICT', '그사이 요청 상태가 바뀌었어요');
  }

  const reason = input.reason ?? null;
  const etcText = input.etcText || null;
  // 도착한 요청만, 도착 후 10분 안, 사유 필수 — 모두 상태 기계가 판정한다
  const result = transitionHreq(request.status, 'UNACCEPTABLE', {
    now,
    version: request.version,
    clientVersion: input.version,
    // 도착 전이면 arrived_at 이 없다. 상태 기계가 '도착이 아님'(INVALID_TRANSITION)으로 먼저 막는다
    arrivedAt: request.arrived_at ?? now,
    // '기타'는 글까지 있어야 사유로 본다 (거절과 같음)
    reason: reason === 'etc' && !etcText ? null : reason,
  });

  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE hospital_request
        SET status = $2, reason = $3, reason_text = $4, version = version + 1, updated_at = now()
      WHERE id = $1
     RETURNING version`,
    [requestId, result.to, reason, reason === 'etc' ? etcText : null],
  );
  const version = updated[0].version;

  // 통계 원장 1줄. 누른 직원·PC 는 넣지 않는다 (거절 통계는 병원 단위로만 본다)
  await recordRejection(client, {
    transportId: target.transport_id,
    hospitalId: target.hospital_id,
    source: 'unacceptable',
    reason,
    reasonText: reason === 'etc' ? etcText : null,
  });

  const common = {
    entityType: 'hospital_request',
    entityId: String(requestId),
    entityVersion: version,
  };
  const events: EventRecord[] = [];
  const teamId = transports[0]?.team_id;
  if (teamId) {
    // 사유는 코드만 (기타 글은 넣지 않는다: 병원이 환자 정보를 적을 수 있어서, 절대 규칙 5).
    // 앱은 경보와 함께 'A병원 수용 불가 · 해당 전문의 부재'를 띄우고 '다시 요청하기'로 직전 환자 화면(SFR-157)을 연다
    events.push({
      room: `team:${teamId}`,
      name: 'transport.unacceptable',
      ...common,
      payload: {
        transportId: target.transport_id,
        hospitalName: target.hospital_name,
        reason: reason ?? '',
      },
    });
  }
  // 같은 병원 다른 PC 의 상세·도착 예정 목록도 '수용 불가'로 바꾼다
  events.push(
    {
      room: `hospital:${pc.hospitalId}`,
      name: 'request.changed',
      ...common,
      payload: {
        requestId,
        status: result.to,
        closeReason: result.closeReason,
        byName: shifts[0].staff_name,
        pcName: pc.pcName,
      },
    },
    {
      room: `hospital:${pc.hospitalId}`,
      name: 'incoming.updated',
      ...common,
      // 이벤트에는 ID 만. 화면은 받으면 GET /hw/incoming 으로 다시 받는다
      payload: { requestId },
    },
  );
  return appendEvents(client, events);
}
