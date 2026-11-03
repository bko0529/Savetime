// 환경 변수 검사: 값이 빠졌으면 서버가 켜질 때 바로 멈춰서, 운영 중에 터지는 일을 막는다.
import { z } from 'zod';

const schema = z.object({
  // 값을 빠뜨린 서버가 개발 모드로 켜지면 인증 없는 API가 열린다. 빠뜨리면 운영으로 본다.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_ROLE: z.enum(['main', 'admin']).default('main'),
  // 짧은 키는 추측해서 토큰을 위조할 수 있다. 무작위 32바이트(base64 44자) 이상을 쓴다.
  // 수집 스크립트처럼 로그인이 필요 없는 실행도 있어서 여기서는 비워 둘 수 있고, API 서버가 켜질 때 따로 확인한다.
  // .env.example을 그대로 복사하면 'JWT_SECRET=' 빈 값이 들어온다. 빈 값은 '없음'으로 본다.
  JWT_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
  SHIFT_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(14),
  PUBLIC_DATA_API_KEY: z.string().optional(),
  PUBLIC_DATA_DAILY_LIMIT: z.coerce.number().int().positive().default(10_000),
  COLLECT_REGIONS: z.string().optional(),
  KAKAO_REST_API_KEY: z.string().optional(),
  // 자동차 길찾기 무료량 (ASM-12). 늘어나면 이 값만 바꾼다
  KAKAO_DIRECTIONS_DAILY_LIMIT: z.coerce.number().int().positive().default(10_000),
  // 카카오 로컬(주소 검색) 하루 무료량. 늘어나면 이 값만 바꾼다
  KAKAO_LOCAL_DAILY_LIMIT: z.coerce.number().int().positive().default(100_000),
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
