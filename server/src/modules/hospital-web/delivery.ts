// 새 요청 알리기와 '받았음' 판정 (SFR-117, SFR-161, 실시간 설계 4-2 '전달 판정')
//   알림 켠 탭(hospital:{id}:on)마다 request.new 를 보내고 5초 기다린다.
//   1개라도 '받았어요'(ack)가 오면 전달 → delivered_at 기록.
//   하나도 안 오면(또는 알림 켠 탭이 없으면) 전달 실패 → 상태 전이 함수로 delivery_failed.
//   답하지 않은 탭은 요청 대상에서 빼고 hospital.alarm_off{no_ack} 를 보낸다 (잠든 탭에 계속 보내지 않게).
// 이송 건 만들기·다시 요청이 커밋된 뒤에 부른다. 대원 앱으로 보내는 집계(request.delivered)는 부르는 쪽이 결과로 만든다.
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { transitionHreq, TransitionError, type HreqStatus } from '../../domain/stateMachine.js';
import { alarmRoom, envelope, turnAlarmOff, type HospitalNamespace } from './realtime.js';

export const ACK_TIMEOUT_MS = 5_000;
// 이벤트에는 고정 문구만. 증상·나이·측정값은 넣지 않는다 (절대 규칙 5, SER-014)
export const NEW_REQUEST_LABEL = '새 이송 요청';

export interface DeliveryDeps {
  pool: pg.Pool;
  hospitalIo: HospitalNamespace;
  // 테스트에서만 줄인다
  ackTimeoutMs?: number;
}

export interface DeliveryResult {
  delivered: number[];
  failed: number[];
}

export async function deliverNewRequests(
  deps: DeliveryDeps,
  requestIds: number[],
): Promise<DeliveryResult> {
  // 병원마다 따로, 동시에 보낸다. 한 병원의 5초 기다림이 다른 병원을 늦추지 않는다
  const results = await Promise.all(requestIds.map((id) => deliverOne(deps, id)));
  return {
    delivered: requestIds.filter((_, i) => results[i] === 'delivered'),
    failed: requestIds.filter((_, i) => results[i] === 'failed'),
  };
}

async function deliverOne(
  { pool, hospitalIo, ackTimeoutMs = ACK_TIMEOUT_MS }: DeliveryDeps,
  requestId: number,
): Promise<'delivered' | 'failed' | 'skipped'> {
  const { rows } = await pool.query<{
    hospital_id: string;
    status: HreqStatus;
    respond_until: Date;
    now: Date;
  }>(
    `SELECT hr.hospital_id, hr.status, r.respond_until, now() AS now
       FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
      WHERE hr.id = $1`,
    [requestId],
  );
  const row = rows[0];
  // 그사이 닫혔으면(취소 등) 보내지 않는다
  if (!row || row.status !== 'waiting') return 'skipped';
  const hospitalId = Number(row.hospital_id);

  const tabs = await hospitalIo.in(alarmRoom(hospitalId)).fetchSockets();
  const event = envelope(alarmRoom(hospitalId), row.now, {
    requestId,
    label: NEW_REQUEST_LABEL,
    respondUntil: row.respond_until.toISOString(),
  });
  // 탭마다 따로 보내야 누가 답하지 않았는지 안다. 다른 서버에 붙은 탭도 Redis 어댑터로 답을 받는다
  const answers = await Promise.all(
    tabs.map(async (tab) => {
      try {
        await hospitalIo.to(tab.id).timeout(ackTimeoutMs).emitWithAck('request.new', event);
        return { tab, ok: true };
      } catch {
        return { tab, ok: false };
      }
    }),
  );

  const silent = answers.filter((a) => !a.ok).map((a) => a.tab);
  if (silent.length > 0) await turnOffSilentTabs(pool, hospitalIo, hospitalId, silent, answers);

  if (answers.some((a) => a.ok)) {
    // '받았음' 시각만 남긴다. 상태는 그대로 대기
    await pool.query(
      'UPDATE hospital_request SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL',
      [requestId],
    );
    return 'delivered';
  }
  return (await markDeliveryFailed(pool, requestId)) ? 'failed' : 'skipped';
}

// 답하지 않은 탭은 요청 대상에서 뺀다. 그 PC 의 탭이 하나도 답하지 않았으면
// 근무의 알림 켜짐도 지워서, 연결이 다시 붙어도 저절로 되살아나지 않고 사람이 다시 켜게 한다
async function turnOffSilentTabs(
  pool: pg.Pool,
  hospitalIo: HospitalNamespace,
  hospitalId: number,
  silent: { id: string; data: { pc: { pcId: number } } }[],
  answers: { tab: { data: { pc: { pcId: number } } }; ok: boolean }[],
): Promise<void> {
  const answeredPcs = new Set(answers.filter((a) => a.ok).map((a) => a.tab.data.pc.pcId));
  const silentPcs = [...new Set(silent.map((t) => t.data.pc.pcId))].filter(
    (pcId) => !answeredPcs.has(pcId),
  );
  const { rows } = await pool.query<{ now: Date }>(
    `WITH off AS (
       UPDATE hospital_shift SET alarm_on_at = NULL
        WHERE pc_id = ANY($1::bigint[]) AND ended_at IS NULL
     )
     SELECT now() AS now`,
    [silentPcs],
  );
  turnAlarmOff(hospitalIo, { hospitalId, tabs: silent.map((t) => t.id) }, 'no_ack', rows[0].now);
}

// 상태 바꾸기는 규칙대로: 행 잠금(FOR UPDATE) → 상태 전이 함수 → version 이 같을 때만 저장 (절대 규칙 4·8)
async function markDeliveryFailed(pool: pg.Pool, requestId: number): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: HreqStatus; version: number; now: Date }>(
      'SELECT status, version, now() AS now FROM hospital_request WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    const row = rows[0];
    if (!row) return false;
    let to: HreqStatus;
    try {
      ({ to } = transitionHreq(row.status, 'NO_ACK_5S', { now: row.now, version: row.version }));
    } catch (err) {
      // 5초 사이에 다른 이유로 이미 바뀌었으면(취소 등) 그대로 둔다
      if (err instanceof TransitionError) return false;
      throw err;
    }
    const { rowCount } = await client.query(
      `UPDATE hospital_request SET status = $2, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $3`,
      [requestId, to, row.version],
    );
    return rowCount === 1;
  });
}
