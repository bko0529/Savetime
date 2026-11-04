// 대원 앱이 이송 건을 바꾸는 API(확정·취소·도착)가 같이 쓰는 입구 처리.
// - 내 팀 이송 건만 잠그고, 남의 것은 있는지조차 알리지 않는다 (SER-010)
// - 상태 전이표가 막으면 이유와 함께 최신 상태(details.current)를 돌려줘 앱이 바로 화면을 바꾸게 한다 (SFR-160, 오류 코드표)
import type pg from 'pg';
import { TransitionError, type TransportStatus } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { loadTransport } from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const transportNotFound = () => new AppError(404, 'NOT_FOUND', '이송 건을 찾을 수 없어요');

// 주소의 transportId가 UUID 모양이 아니면 DB에 묻지 않고 404
export function transportIdParam(raw: unknown): string {
  const id = String(raw);
  if (!UUID.test(id)) throw transportNotFound();
  return id;
}

export interface LockedTransport {
  status: TransportStatus;
  version: number;
  team_id: string;
  location_consent: boolean;
}

// 이송 건 행부터 잠근다 (stateMachine.ts 규칙 5). 같은 이송 건을 바꾸는 요청이 한 줄로 선다
export async function lockMyTransport(
  client: pg.PoolClient,
  transportId: string,
  paramedicId: string,
): Promise<LockedTransport> {
  const { rows } = await client.query<LockedTransport>(
    `SELECT t.status, t.version, t.team_id, t.location_consent
       FROM transport t
       JOIN team_member tm ON tm.team_id = t.team_id AND tm.left_at IS NULL AND tm.paramedic_id = $2
      WHERE t.id = $1
      FOR UPDATE OF t`,
    [transportId, paramedicId],
  );
  if (!rows[0]) throw transportNotFound();
  return rows[0];
}

// 일(트랜잭션)을 하다 상태 전이표에 막히면, 롤백된 뒤의 최신 상태를 붙여 다시 던진다
export async function withCurrentOnBlock<T>(
  pool: pg.Pool,
  transportId: string,
  paramedicId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof TransitionError) {
      const current = await loadTransport(pool, transportId, paramedicId);
      throw new AppError(err.code === 'VERSION_REQUIRED' ? 400 : 409, err.code, err.message, {
        current,
      });
    }
    throw err;
  }
}
