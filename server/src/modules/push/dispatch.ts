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

// 받침이 있으면 '이', 없으면 '가' (예: 'B대학교병원이', '세브란스가'). 한글이 아니면 '이(가)'
function subjectParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return '이(가)';
  return code % 28 === 0 ? '가' : '이';
}

// 푸시 대상 (요구사항 SFR-130 트리거별 구현 시점): 첫 승인 · 전부 거절 · 2분 만료 (S3)
// · 승인 취소 (SFR-128) · 승인 해제 1분 전·해제 (SFR-127) · 확정 병원 추가 메모 (SFR-140) (S4)
// · 병원 도착 확인 요청 (SFR-144) (S7)
export async function messageFor(pool: pg.Pool, event: LoggedEvent): Promise<PushMessage | null> {
  const p = event.payload;
  const data = (extra: Record<string, string> = {}) => ({
    event: event.name,
    transportId: String(p.transportId ?? ''),
    ...extra,
  });

  // 가입 승인·반려 결과 (SFR-022·083). 대원 개인 방으로 온다. 앱을 닫고 기다리는 경우가 많다
  if (event.name === 'account.signup_result') {
    return {
      title: TITLE,
      body:
        p.result === 'approved'
          ? '가입이 승인됐어요 · 로그인해서 근무를 시작하세요'
          : '가입이 반려됐어요 · 사유를 확인하고 다시 신청해 주세요',
      data: { event: event.name, result: String(p.result ?? '') },
    };
  }
  // 팀 초대 (SFR-159). 잠금 화면에 보이니 보낸 사람 이름은 빼고, 누가 보냈는지는 앱의 초대 카드에서 본다
  if (event.name === 'team.invited') {
    return {
      title: TITLE,
      body: '팀 초대가 왔어요 · 5분 안에 수락해 주세요',
      data: { event: event.name, inviteId: String(p.inviteId ?? '') },
    };
  }
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
  // 병원 승인 취소. 확정(이동 중) 병원이면 '다시 요청'을 눌러야 하니 꼭 알린다 (SFR-128·130).
  // 문구는 실시간 설계 5장 그대로, 병원 이름만 (환자 정보 없음)
  if (event.name === 'request.cancelled' && typeof p.hospitalName === 'string') {
    const name = p.hospitalName;
    return {
      title: TITLE,
      body: `${name}${subjectParticle(name)} 승인을 취소했어요`,
      data: data(),
    };
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
  // 승인 유효 5분 (SFR-127). 4분 경보는 실시간 설계 5장 문구 그대로
  if (event.name === 'approval.expiring') {
    return { title: TITLE, body: '1분 뒤 승인이 해제돼요 · 병원을 골라 주세요', data: data() };
  }
  if (event.name === 'approval.expired') {
    return {
      title: TITLE,
      body: '승인 시간 5분이 지나 해제됐어요 · 추천 병원을 확인하세요',
      data: data(),
    };
  }
  // 확정 병원 추가 메모 (SFR-140). 메모 글은 넣지 않는다: 병원이 환자 정보를 적을 수도 있고
  // 푸시는 잠금 화면에 보인다 (절대 규칙 5). 내용은 앱을 열어 GET /transports/current 로 본다
  if (event.name === 'hospital.extra_memo' && typeof p.hospitalName === 'string') {
    const name = p.hospitalName;
    return {
      title: TITLE,
      body: `${name}${subjectParticle(name)} 추가 메모를 보냈어요`,
      data: data(),
    };
  }
  // 위치 미동의 건에 병원 웹이 '도착 확인'을 눌렀다 (SFR-144, 실시간 설계 표). 대원이 앱을 열어 '도착 처리'를 눌러야 끝난다
  if (event.name === 'transport.arrive_requested' && typeof p.hospitalName === 'string') {
    return {
      title: TITLE,
      body: `${p.hospitalName}에서 도착을 확인했어요 · 도착 처리할까요?`,
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
    // 팀 방(팀원 모두) 또는 대원 개인 방(가입 결과 등)만 푸시한다
    const team = event.room.startsWith('team:');
    if (!team && !event.room.startsWith('paramedic:')) return;
    const message = await messageFor(pool, event);
    if (!message) return;

    let members: { paramedic_id: string }[];
    if (team) {
      ({ rows: members } = await pool.query<{ paramedic_id: string }>(
        'SELECT paramedic_id FROM team_member WHERE team_id = $1 AND left_at IS NULL',
        [event.room.slice('team:'.length)],
      ));
    } else {
      members = [{ paramedic_id: event.room.slice('paramedic:'.length) }];
    }
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
