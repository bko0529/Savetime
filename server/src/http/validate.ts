// 요청 본문 검사. 틀린 칸 이름만 알려 주고 값은 돌려주지 않는다 (비밀번호·환자 정보가 들어 있을 수 있음).
import type { z } from 'zod';
import { AppError } from './errors.js';

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new AppError(400, 'VALIDATION_FAILED', '입력 형식이 맞지 않아요', { fields });
  }
  return parsed.data;
}
