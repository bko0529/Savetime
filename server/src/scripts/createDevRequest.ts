// 개발용 새 요청 보내기: npm run request:dev -- [병원 public_id]
// 대원 앱의 '병원에 요청'이 생기기 전까지 병원 웹의 새 요청 창·알림음을 시험하려고 쓴다. 운영 DB 에서는 실행하지 않는다.
// 이 스크립트는 '두 번째 서버'처럼 동작한다: 켜져 있는 서버에 붙은 병원 탭으로 Redis 어댑터를 거쳐 보낸다.
import { Redis } from 'ioredis';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { deliverNewRequests } from '../modules/hospital-web/delivery.js';
import { hospitalNamespace } from '../modules/hospital-web/realtime.js';
import { createRealtime } from '../modules/realtime/io.js';
import { addHospitalRequest } from '../testing/hospitalRequests.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('운영 환경에서는 개발용 요청을 만들 수 없어요 (NODE_ENV=development 확인)');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const redis = new Redis(config.REDIS_URL);
const realtime = createRealtime({ redis });
try {
  // 병원을 정해 주지 않으면 PC 가 등록된 병원 중 가장 최근에 쓴 곳
  const { rows } = await pool.query<{ id: string }>(
    process.argv[2]
      ? 'SELECT id FROM hospital WHERE public_id = $1'
      : `SELECT hospital_id AS id FROM hospital_pc WHERE released_at IS NULL
          ORDER BY last_used_at DESC LIMIT 1`,
    process.argv[2] ? [process.argv[2]] : [],
  );
  if (!rows[0])
    throw new Error('병원을 찾지 못했어요. license:dev 로 병원을 만들고 PC 를 등록하세요');

  const requestId = await addHospitalRequest(pool, rows[0].id);
  const hospitalIo = hospitalNamespace(realtime.io, { pool, allowedOrigins: [] });
  const result = await deliverNewRequests({ pool, hospitalIo }, [requestId]);
  console.log(
    result.delivered.length > 0
      ? `요청 R-${requestId} 전달됨 (알림 켠 탭이 받았어요)`
      : `요청 R-${requestId} 전달 실패 (알림 켠 탭이 없거나 5초 안에 답하지 않았어요)`,
  );
} finally {
  await realtime.close();
  await pool.end();
  redis.disconnect();
}
