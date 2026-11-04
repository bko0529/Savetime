// 대원 알림 푸시 (SFR-130, 실시간 설계 5장). 실시간 이벤트가 커밋돼 팀 방에 나갈 때, 푸시 대상 이벤트면 팀원마다:
//   앱이 화면에 보이는 연결이 있음 → 웹소켓만 (앱이 직접 진동·소리)
//   그 밖 (앱 꺼짐·백그라운드·화면 꺼짐·끊김) → FCM 푸시도
// 문구는 잠금 화면에 보이므로 환자 정보를 넣지 않는다 (병원 이름·분·안내만, 절대 규칙 5).
// 화면에 보이는지는 Redis에 연결마다 적어 둔다. 서버 2대가 같은 값을 본다 (절대 규칙 7).
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { LoggedEvent } from '../realtime/eventLog.js';

export interface PushMessage {
  title: string;
  body: string;
  // 누르면 앱이 해당 화면으로 바로 간다. 문자열만 (FCM data 규칙)
  data: Record<string, string>;
}

// 실제 발송(FCM)을 이 모양 뒤에 숨긴다. 테스트는 가짜 함수를 넘긴다
export type PushSender = (
  tokens: string[],
  message: PushMessage,
) => Promise<{ invalidTokens: string[] }>;

const TITLE = '세이브타임';
// 연결이 끊김 처리 없이 사라져도(서버가 갑자기 죽음) 언젠가는 지워지게 한다. 근무 최대 14시간
const VISIBLE_TTL_SECONDS = 14 * 60 * 60;
const visibleKey = (paramedicId: string) => `push:visible:${paramedicId}`;

// 앱이 app.visibility를 보낼 때마다 그 연결의 값을 적는다
export async function setVisible(
  redis: Redis,
  paramedicId: string,
  socketId: string,
  visible: boolean,
): Promise<void> {
  const key = visibleKey(paramedicId);
  await redis.hset(key, socketId, visible ? '1' : '0');
  await redis.expire(key, VISIBLE_TTL_SECONDS);
}

export async function forgetConnection(
  redis: Redis,
  paramedicId: string,
  socketId: string,
): Promise<void> {
  await redis.hdel(visibleKey(paramedicId), socketId);
}

async function isVisible(redis: Redis, paramedicId: string): Promise<boolean> {
  try {
    return (await redis.hvals(visibleKey(paramedicId))).includes('1');
  } catch {
    // Redis를 못 보면 '안 보임'으로 친다. 알림을 한 번 더 받는 쪽이 놓치는 쪽보다 낫다
    return false;
  }
}

// S3 푸시 대상 (요구사항 SFR-130 트리거별 구현 시점): 첫 승인 · 전부 거절 · 2분 만료
export async function messageFor(pool: pg.Pool, event: LoggedEvent): Promise<PushMessage | null> {
  const p = event.payload;
  const data = (extra: Record<string, string> = {}) => ({
    event: event.name,
    transportId: String(p.transportId ?? ''),
    ...extra,
  });

  if (event.name === 'request.approved' && p.firstApproval === true) {
    const { rows } = await pool.query<{ name: string; eta_min: number | null }>(
      `SELECT h.name, hr.eta_min FROM hospital_request hr JOIN hospital h ON h.id = hr.hospital_id
        WHERE hr.id = $1`,
      [p.hospitalRequestId],
    );
    if (!rows[0]) return null;
    const eta = rows[0].eta_min === null ? '' : ` · ${rows[0].eta_min}분`;
    return { title: TITLE, body: `${rows[0].name} 승인${eta}`, data: data() };
  }
  if (event.name === 'request.expired') {
    return {
      title: TITLE,
      body: p.anyApproved
        ? '응답 시간 2분이 지났어요 · 승인한 병원을 골라 주세요'
        : '응답 시간 2분이 지났어요 · 가까운 병원에 전화로 확인하세요',
      data: data(),
    };
  }
  if (event.name === 'transport.status' && p.status === 'fallback' && p.reason === 'all_rejected') {
    return {
      title: TITLE,
      body: '모든 병원이 거절했어요 · 가까운 병원에 전화로 확인하세요',
      data: data(),
    };
  }
  return null;
}

export interface PushDispatcher {
  // 커밋된 이벤트를 받아 필요한 팀원에게만 보낸다. 실패해도 예외를 밖으로 내지 않는다
  handle(events: LoggedEvent[]): Promise<void>;
}

export function createPushDispatcher(deps: {
  pool: pg.Pool;
  redis: Redis;
  sender: PushSender;
  logger: Logger;
}): PushDispatcher {
  const { pool, redis, sender, logger } = deps;

  async function one(event: LoggedEvent): Promise<void> {
    if (!event.room.startsWith('team:')) return;
    const message = await messageFor(pool, event);
    if (!message) return;

    const teamId = event.room.slice('team:'.length);
    const { rows: members } = await pool.query<{ paramedic_id: string }>(
      'SELECT paramedic_id FROM team_member WHERE team_id = $1 AND left_at IS NULL',
      [teamId],
    );
    const away: string[] = [];
    for (const m of members) {
      if (!(await isVisible(redis, m.paramedic_id))) away.push(m.paramedic_id);
    }
    if (away.length === 0) return;

    const { rows: devices } = await pool.query<{ fcm_token: string }>(
      'SELECT fcm_token FROM push_device WHERE paramedic_id = ANY($1::bigint[])',
      [away],
    );
    if (devices.length === 0) return;

    const { invalidTokens } = await sender(
      devices.map((d) => d.fcm_token),
      message,
    );
    // 앱을 지웠거나 토큰이 바뀐 기기는 다음부터 보내지 않는다
    if (invalidTokens.length > 0) {
      await pool.query('DELETE FROM push_device WHERE fcm_token = ANY($1::text[])', [
        invalidTokens,
      ]);
    }
  }

  return {
    async handle(events) {
      for (const event of events) {
        try {
          await one(event);
        } catch (err) {
          // 토큰·문구는 로그에 남기지 않는다
          logger.error({ message: (err as Error).message, event: event.name }, '푸시 실패');
        }
      }
    },
  };
}
