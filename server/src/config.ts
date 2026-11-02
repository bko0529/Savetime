// 환경 변수 검사: 값이 빠졌으면 서버가 켜질 때 바로 멈춰서, 운영 중에 터지는 일을 막는다.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_ROLE: z.enum(['main', 'admin']).default('main'),
  PUBLIC_DATA_API_KEY: z.string().optional(),
  PUBLIC_DATA_DAILY_LIMIT: z.coerce.number().int().positive().default(10_000),
  COLLECT_REGIONS: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // 값은 비밀일 수 있으니 이름만 보여 준다 (SER-001)
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`환경 변수를 확인하세요: ${names}`);
  }
  return parsed.data;
}
