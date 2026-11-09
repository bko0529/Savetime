// 변경 사항 보내기 (SFR-105·121, 부록 A11, 사건 ASSESSMENT_UPDATED). 상태는 그대로이고 환자 평가만 새 행(seq+1)으로 쌓는다.
// - 무엇을 보낼지는 서버가 정한다: 팀 작성 중 정보(SFR-114)와 마지막으로 보낸 행을 칸별로 비교 (assessment.ts changedFields)
// - 누가 눌러도 한 번만: 이송 건 행을 잠그고 baseSeq 를 마지막 seq 와 비교한다. 먼저 보낸 팀원이 있으면 409
// - 실시간 이벤트에는 요청 ID·바뀐 칸 이름·seq 만 (shared/events.ts). 값은 환자 정보라 넣지 않고(규칙 5) 병원 웹이 상세를 다시 읽는다
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { transitionTransport } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { paramedicAuth } from '../auth/guards.js';
import { appendEvents, type EventRecord, type LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { lockMyTransport, transportIdParam, withCurrentOnBlock } from './access.js';
import {
  ASSESSMENT_COLUMN,
  ASSESSMENT_FIELDS,
  assessmentValues,
  changedFields,
  draftAndLastSent,
} from './assessment.js';

// baseSeq 가 빠지면 상태 전이 함수가 VERSION_REQUIRED 로 판정하게 선택 칸으로 둔다
const sendSchema = z.object({ baseSeq: z.number().int().min(0).optional() });

interface SendOutcome {
  body: { seq: number; changedFields: string[] };
  events: LoggedEvent[];
}

export async function sendAssessment(
  client: pg.PoolClient,
  input: { transportId: string; paramedicId: string; baseSeq?: number },
): Promise<SendOutcome> {
  const { transportId } = input;
  // 이송 건 행을 잠근다: 두 팀원이 같이 눌러도 한 줄로 서서 seq 가 하나만 는다
  const transport = await lockMyTransport(client, transportId, input.paramedicId);
  const now = (await client.query<{ now: Date }>('SELECT now()')).rows[0].now;
  const { draft, last, lastSeq } = await draftAndLastSent(client, transportId, transport.team_id);

  // 표(요청 중·전화 확인·이동 중만) → 버전 순서. 여기서 '버전'은 마지막으로 보낸 seq 다.
  // 이송 건 version 은 올리지 않는다: 이송 건 행의 상태가 바뀐 게 아니다 (stateMachine.ts 규칙 4)
  transitionTransport(transport.status, 'ASSESSMENT_UPDATED', {
    now,
    version: lastSeq,
    clientVersion: input.baseSeq,
  });

  const fields = draft ? changedFields(last, draft) : [];
  if (!draft || fields.length === 0) {
    throw new AppError(409, 'NOTHING_TO_SEND', '보낼 변경 사항이 없어요');
  }
  // 주 증상은 병원이 받아 볼 최소 정보라 지운 채로는 보내지 않는다 (SFR-108, 이송 요청과 같은 규칙)
  if (typeof draft.chiefComplaint !== 'string' || !draft.chiefComplaint.trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '주 증상을 입력해 주세요', {
      fields: ['chiefComplaint'],
    });
  }

  // 작성 중 정보 전체를 새 행으로. 앞 행이 그대로 남아 '바뀌기 전후 값과 시각'이 기록된다 (SFR-105)
  const seq = lastSeq + 1;
  const columns = ASSESSMENT_FIELDS.map((f) => ASSESSMENT_COLUMN[f]);
  await client.query(
    `INSERT INTO assessment (transport_id, seq, ${columns.join(', ')})
     VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(', ')})`,
    [transportId, seq, ...assessmentValues(draft)],
  );
  // 환자 정보 갱신도 '활동'이다 (2시간 자동 종료 시계, SFR-086)
  await client.query('UPDATE transport SET last_activity_at = now() WHERE id = $1', [transportId]);

  // 받는 병원: 요청 중·전화 확인 중이면 아직 응답 안 한 병원과 유효한 승인 병원, 이동 중이면 목적지 병원 (SFR-105)
  const moving = transport.status === 'moving';
  const { rows: targets } = await client.query<{ id: string; hospital_id: string }>(
    `SELECT hr.id, hr.hospital_id
       FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
      WHERE r.transport_id = $1
        AND (CASE WHEN $2 THEN hr.status = 'confirmed'
                  ELSE (hr.status = 'waiting' AND r.respond_until > now())
                    OR (hr.status = 'approved' AND r.approval_valid_until > now()) END)
      ORDER BY hr.id`,
    [transportId, moving],
  );

  const { rows: me } = await client.query<{ name: string }>(
    'SELECT name FROM paramedic WHERE id = $1',
    [input.paramedicId],
  );
  const events: EventRecord[] = targets.map((t) => ({
    room: `hospital:${t.hospital_id}`,
    // 요청 목록 행 강조 / 도착 예정 목록 강조 (실시간 설계 4-2)
    name: moving ? 'incoming.updated' : 'request.updated',
    entityType: 'hospital_request',
    entityId: t.id,
    // shared/events.ts 모양 그대로: 요청 ID·바뀐 칸 이름만
    payload: { requestId: Number(t.id), changedFields: fields },
  }));
  // 팀원 모두 n = 0, '보냄'. 누가 보냈는지는 이벤트에만 이름으로 (DAR-013)
  events.push({
    room: `team:${transport.team_id}`,
    name: 'assessment.sent',
    entityType: 'transport',
    entityId: transportId,
    payload: { transportId, assessmentSeq: seq, changedFields: fields, byName: me[0].name },
  });

  return { body: { seq, changedFields: fields }, events: await appendEvents(client, events) };
}

export function assessmentSendRouter(
  pool: pg.Pool,
  guards: RequestHandler[],
  realtime?: Realtime,
): Router {
  const router = Router();
  router.post('/transports/:transportId/assessments', ...guards, async (req, res) => {
    const transportId = transportIdParam(req.params.transportId);
    const input = parseBody(sendSchema, req.body);
    const { paramedicId } = paramedicAuth(res);
    const outcome = await withCurrentOnBlock(pool, transportId, paramedicId, () =>
      withTransaction(pool, (client) =>
        sendAssessment(client, { transportId, paramedicId, baseSeq: input.baseSeq }),
      ),
    );
    // 커밋된 뒤에만 보낸다
    realtime?.publish(outcome.events);
    res.json(outcome.body);
  });
  return router;
}
