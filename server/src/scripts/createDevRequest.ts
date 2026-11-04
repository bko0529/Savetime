// 개발용 병원 요청 만들기: npm run request:dev -w server -- [병원 public_id]
// 대원 앱의 '병원에 요청'이 없어도 병원 웹의 요청 목록·상세를 시험하려고 쓴다. 운영 DB 에서는 실행하지 않는다.
// 요청만 DB 에 넣는다. 새 요청 창·알림음(실시간 전달)은 이송 건 만들기(#27·#28)를 거칠 때만 뜬다.
// 그래서 만든 뒤에는 병원 웹에서 새로고침하면 목록에 보인다.
import pg from 'pg';
import { loadConfig } from '../config.js';
import { addHospitalRequest } from '../testing/hospitalRequests.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('운영 환경에서는 개발용 요청을 만들 수 없어요 (NODE_ENV=development 확인)');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
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

  // 상세 화면 확인용 예시 값 (산소포화도 86% 는 정상 범위 밖이라 빨간색으로 보인다)
  const requestId = await addHospitalRequest(pool, rows[0].id, {
    chiefComplaint: '갑작스러운 두통',
    assessment: {
      sex: 'M',
      age_band: '60s',
      consciousness: 'alert',
      bp: '150/90',
      pulse: 88,
      spo2: 86,
    },
  });
  console.log(`요청 R-${requestId} 만듦 (2분 안에 병원 웹을 새로고침하면 목록에 보여요)`);
} finally {
  await pool.end();
}
