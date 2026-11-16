// 하루 한 번 정합성 점검 (QUR-014). 다른 주기 작업이 제대로 돌았다면 0건이어야 하는 것들을 훑는다.
// 고치지는 않고 찾기만 한다: 발견하면 서버 로그에 ID 를 남기고 관리자 알림(SFR-100) 1건을 올린다.
// 판정은 모두 DB now() (규칙 6). 서버가 2대여도 BullMQ 가 한 번만 돌린다 (규칙 7)
//
// ① 마지막 활동 후 2시간이 지났는데 아직 진행 중인 이송 건 → 자동 종료(1분마다)가 멈췄다는 뜻
// ② 확정됐는데 다른 병원 요청이 아직 열려 있는 건 → 병원 화면에 끝난 요청이 남아 있다는 뜻
// ③ 보내지 못한 이벤트(outbox): 점검하지 않는다. 이벤트는 상태 변경과 같은 트랜잭션에서 event_log 에 먼저 쓰고,
//    놓친 것은 클라이언트가 다시 연결할 때 seq 로 받아 가므로 '보내지 못한 채 남는 이벤트'가 생기지 않는다
// ④ 끝난 이송 건에 남은 원본 위치 기록 → 익명 경로로 바꾸고 지우는 일(SER-002)이 빠졌다는 뜻
import type pg from 'pg';
import type { Logger } from 'pino';
import { ACTIVE } from '../../domain/stateMachine.js';
import { INACTIVE_LIMIT } from '../transport/autoEnd.js';
import { notifyAdmin } from './notifications.js';

export const INTEGRITY_EVERY_MS = 24 * 60 * 60 * 1000;
// 자동 종료는 1분마다 돌아서 2시간을 막 넘긴 건은 아직 안 끝났을 수 있다. 그런 건을 잘못 잡지 않게 여유를 둔다
export const INACTIVE_GRACE = '10 minutes';

export interface IntegrityFindings {
  staleActive: string[];
  openAfterConfirm: string[];
  leftoverLocations: string[];
}

export async function checkIntegrity(db: Pick<pg.Pool, 'query'>): Promise<IntegrityFindings> {
  const { rows: stale } = await db.query<{ id: string }>(
    `SELECT id FROM transport
      WHERE status = ANY($1::transport_status[])
        AND last_activity_at <= now() - $2::interval - $3::interval
      ORDER BY id`,
    [ACTIVE, INACTIVE_LIMIT, INACTIVE_GRACE],
  );
  // 같은 이송 건 안에서 확정(또는 도착)된 병원 요청이 있는데, 다른 병원 요청이 아직 대기·승인으로 열려 있다
  const { rows: open } = await db.query<{ id: string }>(
    `SELECT DISTINCT r.transport_id AS id
       FROM hospital_request hr
       JOIN request_round r ON r.id = hr.round_id
      WHERE hr.status IN ('waiting', 'approved')
        AND EXISTS (
          SELECT 1 FROM hospital_request c
            JOIN request_round cr ON cr.id = c.round_id
           WHERE cr.transport_id = r.transport_id AND c.id <> hr.id
             AND c.status IN ('confirmed', 'arrived'))
      ORDER BY 1`,
  );
  const { rows: leftover } = await db.query<{ id: string }>(
    `SELECT DISTINCT lp.transport_id AS id
       FROM location_point lp
       JOIN transport t ON t.id = lp.transport_id
      WHERE t.status IN ('arrived', 'cancelled')
      ORDER BY 1`,
  );
  return {
    staleActive: stale.map((r) => r.id),
    openAfterConfirm: open.map((r) => r.id),
    leftoverLocations: leftover.map((r) => r.id),
  };
}

// 주기 작업 한 번. 발견 건수(합계)를 돌려준다
export async function runIntegrityCheck(pool: pg.Pool, logger: Logger): Promise<number> {
  const found = await checkIntegrity(pool);
  const total =
    found.staleActive.length + found.openAfterConfirm.length + found.leftoverLocations.length;
  if (total === 0) {
    logger.info('정합성 점검: 이상 없음');
    return 0;
  }
  // 로그에는 이송 건 ID 만 남긴다 (환자·대원 정보 없음, SER-012)
  logger.error(found, '정합성 점검: 이상 발견');
  await notifyAdmin(pool, 'integrity', total);
  return total;
}
