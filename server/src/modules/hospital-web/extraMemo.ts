// 병원 웹 추가 메모 (SFR-140). 우리 병원으로 확정된 요청에 한 번만 메모를 더 보낸다 ('CT 고장, 2번 입구로 오세요').
// 요청의 상태가 바뀌는 일이 아니라서 상태 기계(transitionHreq)는 거치지 않는다.
// 대신 다른 변경과 똑같이 트랜잭션 + FOR UPDATE + version 비교로 지킨다 (절대 규칙 8).
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../http/errors.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { HospitalPc } from './pcAuth.js';

// version 이 빠지면 400 VERSION_REQUIRED 를 주려고 선택 칸으로 둔다 (승인·거절과 같은 방식)
export const extraMemoSchema = z.object({
  memo: z.string().trim().min(1).max(50),
  version: z.number().int().optional(),
});
export type ExtraMemoInput = z.infer<typeof extraMemoSchema>;

// 확정 전·끝난 요청 구분: 끝난 요청은 REQUEST_CLOSED, 아직 확정 전이면 INVALID_TRANSITION
const FINISHED = new Set(['closed', 'expired', 'rejected', 'delivery_failed', 'arrived']);

export async function sendExtraMemo(
  client: pg.PoolClient,
  pc: HospitalPc,
  requestId: number,
  input: ExtraMemoInput,
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

  // 누가 보냈는지 남겨야 해서 근무 중인 PC 만 보낸다 (승인·거절과 같음)
  const { rows: shifts } = await client.query<{ staff_name: string }>(
    `SELECT staff_name FROM hospital_shift
      WHERE pc_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [pc.pcId],
  );
  if (!shifts[0]) throw new AppError(409, 'SHIFT_REQUIRED', '근무를 먼저 시작해 주세요');

  // 잠금 순서는 다른 곳과 같게: 이송 건 먼저, 그다음 병원 요청 (교착 방지)
  const { rows: transports } = await client.query<{ team_id: string | null }>(
    'SELECT team_id FROM transport WHERE id = $1 FOR UPDATE',
    [target.transport_id],
  );
  // 두 PC 가 동시에 보내도 여기서 한 줄로 선다. 나중 PC 는 먼저 PC 가 적은 메모를 보고 막힌다
  const { rows: locked } = await client.query<{
    status: string;
    version: number;
    extra_memo: string | null;
  }>('SELECT status, version, extra_memo FROM hospital_request WHERE id = $1 FOR UPDATE', [
    requestId,
  ]);
  const request = locked[0];

  if (FINISHED.has(request.status)) {
    throw new AppError(409, 'REQUEST_CLOSED', '이미 끝난 요청이에요', { status: request.status });
  }
  if (request.status !== 'confirmed') {
    throw new AppError(409, 'INVALID_TRANSITION', '우리 병원으로 확정된 요청에만 보낼 수 있어요', {
      status: request.status,
    });
  }
  // 한 번만 (SFR-140). version 보다 먼저 봐야 '이미 보냄'이라고 정확히 알려 줄 수 있다
  if (request.extra_memo !== null) {
    throw new AppError(409, 'EXTRA_MEMO_USED', '추가 메모는 한 번만 보낼 수 있어요');
  }
  if (input.version === undefined) {
    throw new AppError(400, 'VERSION_REQUIRED', 'version을 같이 보내야 해요');
  }
  if (input.version !== request.version) {
    throw new AppError(409, 'VERSION_CONFLICT', '그사이 요청 상태가 바뀌었어요');
  }

  // 보낸 시각은 DB now() (규칙 6). 행이 바뀌었으니 version 을 1 올린다
  const { rows: updated } = await client.query<{ version: number }>(
    `UPDATE hospital_request
        SET extra_memo = $2, extra_memo_at = now(), version = version + 1, updated_at = now()
      WHERE id = $1
     RETURNING version`,
    [requestId, input.memo],
  );
  const version = updated[0].version;
  // 병원이 움직인 것도 '활동'이다 (SFR-086 2시간 자동 종료 시계). 이송 건 상태는 그대로라 version 은 안 올린다
  await client.query('UPDATE transport SET last_activity_at = now() WHERE id = $1', [
    target.transport_id,
  ]);

  const common = {
    entityType: 'hospital_request',
    entityId: String(requestId),
    entityVersion: version,
  };
  const events: EventRecord[] = [];
  const teamId = transports[0]?.team_id;
  if (teamId) {
    // 메모 글은 넣지 않는다: 병원이 메모 칸에 환자 정보를 적을 수도 있어서 (절대 규칙 5).
    // 앱은 이 이벤트를 받으면 GET /transports/current 로 extraMemo 를 받아 경보와 함께 보여 준다
    events.push({
      room: `team:${teamId}`,
      name: 'hospital.extra_memo',
      ...common,
      payload: {
        transportId: target.transport_id,
        hospitalRequestId: requestId,
        hospitalName: target.hospital_name,
      },
    });
  }
  // 같은 병원 다른 PC 의 상세·도착 예정 목록에서도 '추가 메모' 버튼을 숨긴다
  events.push(
    {
      room: `hospital:${pc.hospitalId}`,
      name: 'request.changed',
      ...common,
      payload: {
        requestId,
        status: 'confirmed',
        closeReason: null,
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
