// 요청 대상 찾기와 요청 회차 만들기 (SFR-109·117·139·162). 이송 생성 · 반경 넓히기(SFR-131) · 다시 요청(SFR-128) ·
// 요청 대상 미리보기(SFR-163)가 이 파일 하나를 같이 쓴다. 그래야 미리보기의 'n곳에 요청합니다'와 실제로 요청이 가는 수가 늘 같다.
import type pg from 'pg';
import { transitionHreq } from '../../domain/stateMachine.js';
import type { EventRecord } from '../realtime/eventLog.js';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

// 요청용 도착 예상 시간 초안: 직선거리 ÷ 평균 40km/h (SFR-129). 길찾기 갱신은 커밋 뒤 routeEta가 한다
const STRAIGHT_KMH = 40;

export interface Target {
  id: string;
  km: number;
  grade: number;
}

export interface TargetQuery {
  lat: number;
  lng: number;
  radiusKm: number;
  // 고른 병원 등급 이상만 (숫자가 같거나 작음). null = 전체 (SFR-162)
  grade: number | null;
  // 이번 이송의 제외 병원을 뺀다 (SFR-086). alreadyRequested면 이번 이송에서 이미 요청한 병원도 뺀다 (반경 넓히기, SFR-131)
  transport?: { id: string; skipAlreadyRequested: boolean };
}

// 요청 대상 = 반경 안 · 병원 계정 활성 · 잠시 요청 중지 아님 · 알림 켠 PC가 있음 (SFR-109·117·139)
// 반경은 위도·경도 네모로 먼저 거르고 하버사인 직선거리로 자른다 (추천 목록과 같은 방식).
// 등급은 여기서 거르지 않고 돌려준 뒤 JS에서 거른다. 미리보기가 등급별 수를 한 번에 세야 해서다
const TARGETS_SQL = `
  SELECT h.id, d.km, h.grade
    FROM hospital h
    CROSS JOIN LATERAL (
      SELECT 2 * 6371 * asin(sqrt(
               power(sin(radians(h.lat::float8 - $1) / 2), 2)
               + cos(radians($1)) * cos(radians(h.lat::float8))
                 * power(sin(radians(h.lng::float8 - $2) / 2), 2))) AS km
    ) d
   WHERE h.lat BETWEEN $1 - $3 / 111.0 AND $1 + $3 / 111.0
     AND h.lng BETWEEN $2 - $3 / (111.0 * cos(radians($1))) AND $2 + $3 / (111.0 * cos(radians($1)))
     AND d.km <= $3
     AND h.account_active AND NOT h.requests_paused
     AND EXISTS (
       SELECT 1 FROM hospital_shift s JOIN hospital_pc p ON p.id = s.pc_id
        WHERE p.hospital_id = h.id AND p.released_at IS NULL
          AND s.alarm_on_at IS NOT NULL AND s.ended_at IS NULL
     )
     AND ($4::uuid IS NULL OR NOT EXISTS (
       SELECT 1 FROM excluded_hospital e WHERE e.transport_id = $4 AND e.hospital_id = h.id))
     AND (NOT $5::boolean OR NOT EXISTS (
       SELECT 1 FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE r.transport_id = $4 AND hr.hospital_id = h.id))
   ORDER BY d.km, h.id`;

// 등급을 거르기 전 전체 대상
async function allTargets(db: Queryable, q: TargetQuery): Promise<Target[]> {
  const { rows } = await db.query<Target>(TARGETS_SQL, [
    q.lat,
    q.lng,
    q.radiusKm,
    q.transport?.id ?? null,
    q.transport?.skipAlreadyRequested ?? false,
  ]);
  return rows;
}

const meetsGrade = (grade: number | null) => (t: Target) => grade === null || t.grade <= grade;

export async function findRequestTargets(db: Queryable, q: TargetQuery): Promise<Target[]> {
  return (await allTargets(db, q)).filter(meetsGrade(q.grade));
}

// 미리보기: 지금 고른 등급의 수 + 등급마다 '그 등급을 고르면 몇 곳'인지 (SFR-163 '등급 바꾸기')
export async function previewRequestTargets(
  db: Queryable,
  q: TargetQuery,
): Promise<{ count: number; byGrade: Record<'1' | '2' | '3', number> }> {
  const all = await allTargets(db, q);
  return {
    count: all.filter(meetsGrade(q.grade)).length,
    byGrade: {
      '1': all.filter(meetsGrade(1)).length,
      '2': all.filter(meetsGrade(2)).length,
      '3': all.filter(meetsGrade(3)).length,
    },
  };
}

export interface NewRound {
  roundId: string;
  event: EventRecord; // round.started (방은 부르는 쪽이 정한다)
}

// 회차 하나를 만들고 대상마다 병원 요청을 보낸다(SEND). 2분 응답 제한·5분 승인 유효는 DB 시각으로 고정 (절대 규칙 6)
export async function insertRound(
  client: pg.PoolClient,
  input: {
    transportId: string;
    kind: 'first' | 'expand' | 're_request' | 'dest_change';
    radiusKm: number;
    targets: Target[];
    now: Date;
    entityVersion: number;
  },
): Promise<NewRound> {
  const { rows: round } = await client.query<{
    id: string;
    round_no: number;
    respond_until: Date;
    approval_valid_until: Date;
  }>(
    `INSERT INTO request_round (transport_id, round_no, kind, radius_km, sent_at, respond_until, approval_valid_until)
     VALUES ($1, (SELECT coalesce(max(round_no), 0) + 1 FROM request_round WHERE transport_id = $1),
             $2, $3, now(), now() + interval '2 minutes', now() + interval '5 minutes')
     RETURNING id, round_no, respond_until, approval_valid_until`,
    [input.transportId, input.kind, input.radiusKm],
  );
  for (const target of input.targets) {
    const { to } = transitionHreq(null, 'SEND', { now: input.now, version: 1 });
    await client.query(
      `INSERT INTO hospital_request (round_id, hospital_id, status, eta_min, eta_source)
       VALUES ($1, $2, $3, $4, 'straight')`,
      [round[0].id, target.id, to, Math.max(1, Math.ceil((target.km / STRAIGHT_KMH) * 60))],
    );
  }
  return {
    roundId: round[0].id,
    event: {
      room: '',
      name: 'round.started',
      entityType: 'transport',
      entityId: input.transportId,
      entityVersion: input.entityVersion,
      payload: {
        transportId: input.transportId,
        roundNo: round[0].round_no,
        kind: input.kind,
        radiusKm: input.radiusKm,
        targetCount: input.targets.length,
        respondUntil: round[0].respond_until.toISOString(),
        approvalValidUntil: round[0].approval_valid_until.toISOString(),
      },
    },
  };
}
