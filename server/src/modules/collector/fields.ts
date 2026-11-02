// 공공 데이터 값 검사. 빈 값을 0으로 읽지 않고, 값 하나가 깨져도 병원 전체를 버리지 않는다.
import { z } from 'zod';

// Number('')와 Number(null)은 0이다. 그대로 두면 '정보 없음'이 '0개'로 바뀐다 (SFR-089).
function blankToUndefined(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

export const optionalInt = z
  .preprocess(blankToUndefined, z.coerce.number().int().optional())
  .catch(undefined);

export const optionalNumber = z
  .preprocess(blankToUndefined, z.coerce.number().optional())
  .catch(undefined);

export const optionalText = z.preprocess(blankToUndefined, z.string().optional()).catch(undefined);

// 같은 병원이 두 번 오면 한 SQL 문에서 같은 행을 두 번 고치게 되어 시·도 전체 저장이 실패한다.
export function lastByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [keyOf(item), item])).values()];
}
