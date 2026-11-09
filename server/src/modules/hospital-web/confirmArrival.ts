// 병원 웹 '도착 확인' (SFR-144, H-03). 도착 예정 목록에서 확정 환자의 '도착 확인'을 누르면:
// - 위치 동의 건: 서버가 아는 구급차 마지막 위치가 응급실 입구 200m 안일 때만 → 대원 앱 도착과 같게 끝낸다
//   (익명 소요시간 저장·위치 기록 익명화까지, finish.ts arriveLockedTransport)
// - 위치 미동의 건: 상태를 바꾸지 않고 대원 앱에 '병원에서 도착 확인을 요청했어요 — 도착 처리할까요?'
// 병원 웹에는 구급차 위치·거리를 절대 보여 주지 않는다. 가깝지 않으면 이유 코드만 준다
import type pg from 'pg';
import { z } from 'zod';
import type { TransportStatus } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { appendEvents, type LoggedEvent } from '../realtime/eventLog.js';
import { arriveLockedTransport } from '../transport/finish.js';
import type { HospitalPc } from './pcAuth.js';

// 입구에서 이 거리 안이어야 '도착 확인'으로 바로 끝낼 수 있다 (SFR-144)
export const NEAR_ENTRANCE_M = 200;

// version 이 빠지면 400 VERSION_REQUIRED 를 주려고 선택 칸으로 둔다 (승인·거절과 같은 방식)
export const confirmArrivalSchema = z.object({ version: z.number().int().optional() });
export type ConfirmArrivalInput = z.infer<typeof confirmArrivalSchema>;

export type ConfirmArrivalResult = 'arrived' | 'asked_paramedic';

// 구급차 마지막 위치가 이 병원 응급실 입구(없으면 병원 좌표) 200m 안인가.
// 위치 기록이 하나도 없으면 null (아직 판단할 수 없음). 거리 계산은 DB 에서 (병원 웹으로 좌표가 나가지 않게)
// 도착 예정 목록(GET /hw/incoming, SFR-121)의 canConfirmArrival 도 이 함수를 쓰면 된다
export async function ambulanceNearEntrance(
  db: Pick<pg.PoolClient, 'query'>,
  transportId: string,
  hospitalId: number,
): Promise<boolean | null> {
  const { rows } = await db.query<{ distance_m: number | null }>(
    `SELECT (
       SELECT 2 * 6371000 * asin(sqrt(
                power(sin(radians(lp.lat - e.lat) / 2), 2) +
                cos(radians(e.lat)) * cos(radians(lp.lat)) * power(sin(radians(lp.lng - e.lng) / 2), 2)))
         FROM location_point lp
        WHERE lp.transport_id = $1
        ORDER BY lp.recorded_at DESC
        LIMIT 1
     )::float8 AS distance_m
       FROM (SELECT COALESCE(entrance_lat, lat)::float8 AS lat, COALESCE(entrance_lng, lng)::float8 AS lng
               FROM hospital WHERE id = $2) e`,
    [transportId, hospitalId],
  );
  const d = rows[0]?.distance_m;
  return d === null || d === undefined ? null : d <= NEAR_ENTRANCE_M;
}

export async function confirmArrival(
  client: pg.PoolClient,
  pc: HospitalPc,
  requestId: number,
  input: ConfirmArrivalInput,
): Promise<{ result: ConfirmArrivalResult; events: LoggedEvent[] }> {
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

  // 누가 눌렀는지 남길 수 있게 근무 중인 PC 만 (승인·거절·추가 메모와 같음)
  const { rows: shifts } = await client.query(
    'SELECT 1 FROM hospital_shift WHERE pc_id = $1 AND ended_at IS NULL LIMIT 1',
    [pc.pcId],
  );
  if (!shifts[0]) throw new AppError(409, 'SHIFT_REQUIRED', '근무를 먼저 시작해 주세요');

  // 잠금 순서는 다른 곳과 같게: 이송 건 먼저, 그다음 병원 요청 (교착 방지).
  // 대원이 같은 순간 '도착'을 눌러도 여기서 한 줄로 서고, 나중 쪽은 바뀐 상태를 보고 막힌다
  const { rows: transports } = await client.query<{
    status: TransportStatus;
    version: number;
    team_id: string;
    location_consent: boolean;
  }>('SELECT status, version, team_id, location_consent FROM transport WHERE id = $1 FOR UPDATE', [
    target.transport_id,
  ]);
  const transport = transports[0];
  const { rows: locked } = await client.query<{ status: string; version: number }>(
    'SELECT status, version FROM hospital_request WHERE id = $1 FOR UPDATE',
    [requestId],
  );
  const request = locked[0];

  // 확정(이동 중)만. 이미 도착·수용 불가·닫힌 요청은 화면에 버튼이 없으니 상태 전이 오류로 돌려준다
  if (request.status !== 'confirmed') {
    throw new AppError(
      409,
      'INVALID_TRANSITION',
      '우리 병원으로 이동 중인 환자만 도착 확인할 수 있어요',
      {
        status: request.status,
      },
    );
  }
  if (input.version === undefined) {
    throw new AppError(400, 'VERSION_REQUIRED', 'version을 같이 보내야 해요');
  }
  if (input.version !== request.version) {
    throw new AppError(409, 'VERSION_CONFLICT', '그사이 요청 상태가 바뀌었어요');
  }

  // 위치 미동의 건: 대원에게 묻기만 한다. 대원이 '도착 처리'를 누르면 POST /transports/{id}/arrive (method=hospital)
  if (!transport.location_consent) {
    // 병원이 움직인 것도 '활동'이다 (SFR-086 2시간 자동 종료 시계). 상태가 그대로라 version 은 올리지 않는다
    await client.query('UPDATE transport SET last_activity_at = now() WHERE id = $1', [
      target.transport_id,
    ]);
    const events = await appendEvents(client, [
      {
        room: `team:${transport.team_id}`,
        name: 'transport.arrive_requested',
        entityType: 'transport',
        entityId: target.transport_id,
        payload: { transportId: target.transport_id, hospitalName: target.hospital_name },
      },
    ]);
    return { result: 'asked_paramedic', events };
  }

  // 위치 동의 건: 마지막 위치가 200m 안이어야 한다. 아직 위치가 없으면 판단할 수 없어 누를 수 없다
  const near = await ambulanceNearEntrance(client, target.transport_id, pc.hospitalId);
  if (near !== true) {
    throw new AppError(409, 'AMBULANCE_NOT_NEAR', '구급차가 아직 응급실 입구 가까이 오지 않았어요');
  }

  // 대원 앱 도착과 같은 처리. 서버가 위치로 판단한 사건이라 이송 건 version 은 받지 않는다 (상태 전이표 A19).
  // 상태 전이는 stateMachine.ts 를 거친다 (절대 규칙 4)
  const { events } = await arriveLockedTransport(
    client,
    target.transport_id,
    transport,
    'hospital',
    undefined,
  );
  return { result: 'arrived', events };
}
