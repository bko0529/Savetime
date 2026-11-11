// 개인정보 자동 파기(DAR-003·010·012·014)를 임시 DB·실제 Redis·메모리 사진 저장소로 확인한다.
// 기간 경계(30일·3년) 바로 앞뒤 기록을 함께 넣어 '지난 것만' 지우는지 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import { createMemoryStorage, createPhotoStore } from '../auth/photoStore.js';
import type { AuthContext } from '../auth/session.js';
import {
  ASSESSMENT_FIELDS,
  ASSESSMENT_KEEP_COLUMNS,
  expirePendingPhotos,
  purgeAnonymousRoutes,
  purgeAssessments,
  purgeRejectedSignups,
  runRetention,
} from './retention.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('CARD')]);

let seq = 0;

// 이송 건 하나에 환자 평가 1건 (sentAgo 전에 보냄)
async function assessmentSentAgo(pool: pg.Pool, sentAgo: string): Promise<string> {
  const paramedicId = await addParamedic(pool, { loginId: `a${randomBytes(3).toString('hex')}` });
  const { rows: team } = await pool.query<{ id: string }>(
    `INSERT INTO team (code, qr_token, created_by) VALUES ($2, 'qr', $1) RETURNING id`,
    [paramedicId, String(5000 + (seq += 1))],
  );
  const transportId = randomUUID();
  await pool.query(
    "INSERT INTO transport (id, team_id, status, location_consent) VALUES ($1, $2, 'arrived', true)",
    [transportId, team[0].id],
  );
  await pool.query(
    `INSERT INTO assessment (transport_id, seq, chief_complaint, sex, age_band, consciousness, bp, pulse,
                             spo2, history, ktas, unknown_fields, sent_at)
     VALUES ($1, 1, '흉통', 'M', '60s', 'alert', '150/90', 110, 93, '고혈압 약 복용', 2, '{onset}',
             now() - $2::interval)`,
    [transportId, sentAgo],
  );
  return transportId;
}

const assessmentOf = async (pool: pg.Pool, transportId: string) =>
  (
    await pool.query(
      `SELECT chief_complaint, sex, age_band, consciousness, bp, pulse, spo2, history, ktas,
              unknown_fields, purged_at IS NOT NULL AS purged
         FROM assessment WHERE transport_id = $1`,
      [transportId],
    )
  ).rows[0];

// 가입 신청 1건. created 전에 신청, result 가 있으면 decided 전에 처리됨
async function signup(
  pool: pg.Pool,
  loginId: string,
  opts: {
    status: 'pending' | 'rejected' | 'approved';
    created: string;
    decided?: string;
    photoKey?: string | null;
  },
): Promise<{ paramedicId: string; signupId: string }> {
  const paramedicId = await addParamedic(pool, { loginId, status: opts.status });
  const result = opts.status === 'pending' ? null : opts.status;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO signup_request (paramedic_id, photo_key, consent_at, created_at, result, reject_reason, decided_at)
     VALUES ($1, $2, now() - $3::interval, now() - $3::interval, $4::varchar,
             CASE WHEN $4::varchar = 'rejected' THEN 'photo_unclear' END,
             CASE WHEN $5::interval IS NULL THEN NULL ELSE now() - $5::interval END)
     RETURNING id`,
    [paramedicId, opts.photoKey ?? null, opts.created, result, opts.decided ?? null],
  );
  return { paramedicId, signupId: rows[0].id };
}

const login = (ctx: AuthContext, loginId: string) =>
  request(createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx }))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });

test('환자 평가는 보낸 지 30일이 지나면 항목을 비우고 행은 남긴다 (DAR-010)', async () => {
  await withAuthContext(async (ctx) => {
    const old = await assessmentSentAgo(ctx.pool, '31 days');
    const recent = await assessmentSentAgo(ctx.pool, '29 days');

    assert.equal(await purgeAssessments(ctx.pool), 1);
    assert.deepEqual(await assessmentOf(ctx.pool, old), {
      chief_complaint: null,
      sex: null,
      age_band: null,
      consciousness: null,
      bp: null,
      pulse: null,
      spo2: null,
      history: null,
      ktas: null,
      unknown_fields: [],
      purged: true,
    });
    const kept = await assessmentOf(ctx.pool, recent);
    assert.equal(kept.chief_complaint, '흉통');
    assert.equal(kept.purged, false);
    // 이송 건은 그대로 남아 응답·시간 통계(SFR-106·126)가 깨지지 않는다
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM transport WHERE id = $1',
      [old],
    );
    assert.equal(rows[0].n, 1);
    // 이미 비운 건 다시 건드리지 않는다
    assert.equal(await purgeAssessments(ctx.pool), 0);
  });
});

test("30일 동안 처리되지 않은 가입 신청은 사진을 지우고 '반려(사진 만료)'로 바꾼 뒤 다시 신청하라고 알린다 (DAR-012)", async () => {
  await withAuthContext(async (ctx) => {
    const storage = createMemoryStorage();
    const photos = createPhotoStore(storage, randomBytes(32));
    const oldKey = await photos.save(JPEG);
    const newKey = await photos.save(JPEG);
    const old = await signup(ctx.pool, 'late01', {
      status: 'pending',
      created: '31 days',
      photoKey: oldKey,
    });
    await signup(ctx.pool, 'new01', { status: 'pending', created: '29 days', photoKey: newKey });

    const { count, events } = await expirePendingPhotos(ctx.pool, ctx.redis, photos);
    assert.equal(count, 1);

    const { rows } = await ctx.pool.query(
      `SELECT s.result, s.reject_reason, s.photo_key, s.decided_at IS NOT NULL AS decided, p.status
         FROM signup_request s JOIN paramedic p ON p.id = s.paramedic_id WHERE s.id = $1`,
      [old.signupId],
    );
    assert.deepEqual(rows[0], {
      result: 'rejected',
      reject_reason: 'photo_expired',
      photo_key: null,
      decided: true,
      status: 'rejected',
    });
    // 저장소에는 30일이 안 된 신청의 사진만 남는다
    assert.equal(storage.keys().length, 1);

    // 신청자에게 결과 알림 (앱이 안 보이면 푸시). 로그인하면 '반려 · 사진 만료'가 보이고 다시 신청할 수 있다
    assert.deepEqual(
      events.map((e) => [e.room, e.name, e.payload]),
      [
        [
          `paramedic:${old.paramedicId}`,
          'account.signup_result',
          { result: 'rejected', reason: 'photo_expired' },
        ],
      ],
    );
    const me = await login(ctx, 'late01');
    assert.equal(me.body.me.status, 'rejected');
    assert.equal(me.body.me.rejectReason, 'photo_expired');

    // 다시 돌아도 같은 신청을 또 처리하지 않는다
    assert.equal((await expirePendingPhotos(ctx.pool, ctx.redis, photos)).count, 0);
  });
});

test('반려된 지 30일이 지나도 다시 신청하지 않으면 신청 기록과 계정 개인 정보를 지운다 (DAR-003)', async () => {
  await withAuthContext(async (ctx) => {
    const gone = await signup(ctx.pool, 'rej01', {
      status: 'rejected',
      created: '40 days',
      decided: '31 days',
    });
    const recent = await signup(ctx.pool, 'rej02', {
      status: 'rejected',
      created: '35 days',
      decided: '29 days',
    });
    // 반려 뒤 다시 신청해 심사 중인 계정과 승인된 계정은 건드리지 않는다
    const retry = await signup(ctx.pool, 'rej03', {
      status: 'rejected',
      created: '40 days',
      decided: '35 days',
    });
    await ctx.pool.query("UPDATE paramedic SET status = 'pending' WHERE id = $1", [
      retry.paramedicId,
    ]);
    await ctx.pool.query(
      `INSERT INTO signup_request (paramedic_id, consent_at) VALUES ($1, now() - interval '2 days')`,
      [retry.paramedicId],
    );
    const approved = await signup(ctx.pool, 'ok01', {
      status: 'approved',
      created: '60 days',
      decided: '50 days',
    });
    await ctx.pool.query(
      "INSERT INTO push_device (paramedic_id, device_id, platform, fcm_token) VALUES ($1, 'd1', 'android', 'tok')",
      [gone.paramedicId],
    );

    assert.equal(await purgeRejectedSignups(ctx.pool, ctx.redis), 1);

    const { rows } = await ctx.pool.query(
      `SELECT status, login_id, name, rank, safety_center, employee_no, password_hash
         FROM paramedic WHERE id = $1`,
      [gone.paramedicId],
    );
    assert.deepEqual(rows[0], {
      status: 'withdrawn',
      login_id: `withdrawn:${gone.paramedicId}`,
      name: '삭제된 가입 신청',
      rank: '',
      safety_center: '',
      employee_no: '',
      password_hash: '',
    });
    const left = async (id: string) =>
      (
        await ctx.pool.query(
          'SELECT count(*)::int AS n FROM signup_request WHERE paramedic_id = $1',
          [id],
        )
      ).rows[0].n;
    assert.equal(await left(gone.paramedicId), 0);
    const { rows: push } = await ctx.pool.query('SELECT count(*)::int AS n FROM push_device');
    assert.equal(push[0].n, 0);
    // 옛 아이디로는 더 로그인할 수 없다
    assert.equal((await login(ctx, 'rej01')).status, 401);

    // 30일이 안 된 반려·다시 신청한 계정·승인된 계정은 그대로
    for (const p of [recent, retry, approved]) assert.ok((await left(p.paramedicId)) > 0);
    const { rows: others } = await ctx.pool.query(
      'SELECT status FROM paramedic WHERE id = ANY($1::bigint[]) ORDER BY id',
      [[recent.paramedicId, retry.paramedicId, approved.paramedicId]],
    );
    assert.deepEqual(
      others.map((r) => r.status),
      ['rejected', 'pending', 'approved'],
    );
  });
});

test('assessment 의 모든 칸이 파기 목록 또는 남기는 목록에 있다 (칸이 늘면 이 테스트가 알려 준다)', async () => {
  await withAuthContext(async (ctx) => {
    const { rows } = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assessment' ORDER BY column_name`,
    );
    const known = new Set([...ASSESSMENT_FIELDS, ...ASSESSMENT_KEEP_COLUMNS]);
    assert.deepEqual(
      rows.map((r) => r.column_name).filter((c) => !known.has(c)),
      [],
      '새 칸이 환자 정보면 ASSESSMENT_FIELDS 에, 아니면 ASSESSMENT_KEEP_COLUMNS 에 넣어 주세요',
    );
  });
});

test('익명 이송 경로는 끝난 지 3년이 지나면 지운다 (DAR-014)', async () => {
  await withAuthContext(async (ctx) => {
    await ctx.pool.query(
      `INSERT INTO anonymous_route (ended_at, distance_m, points)
       VALUES (now() - interval '3 years' - interval '1 day', 1200, '[]'),
              (now() - interval '3 years' + interval '1 day', 900, '[]')`,
    );
    assert.equal(await purgeAnonymousRoutes(ctx.pool), 1);
    const { rows } = await ctx.pool.query('SELECT distance_m FROM anonymous_route');
    assert.deepEqual(rows, [{ distance_m: 900 }]);
  });
});

test('주기 작업 한 번에 네 가지를 모두 하고, 사진 만료 알림 이벤트를 돌려준다', async () => {
  await withAuthContext(async (ctx) => {
    const storage = createMemoryStorage();
    const photos = createPhotoStore(storage, randomBytes(32));
    await assessmentSentAgo(ctx.pool, '40 days');
    await signup(ctx.pool, 'late01', {
      status: 'pending',
      created: '31 days',
      photoKey: await photos.save(JPEG),
    });
    await signup(ctx.pool, 'rej01', { status: 'rejected', created: '40 days', decided: '31 days' });
    await ctx.pool.query(
      `INSERT INTO anonymous_route (ended_at, distance_m, points) VALUES (now() - interval '4 years', 1, '[]')`,
    );

    const events = await runRetention({ pool: ctx.pool, redis: ctx.redis, photos, logger });
    assert.equal(events.length, 1);
    const { rows } = await ctx.pool.query(
      `SELECT (SELECT count(*) FROM assessment WHERE purged_at IS NULL)::int AS assessments,
              (SELECT count(*) FROM signup_request WHERE photo_key IS NOT NULL)::int AS photos,
              (SELECT count(*) FROM paramedic WHERE status = 'rejected')::int AS rejected,
              (SELECT count(*) FROM anonymous_route)::int AS routes`,
    );
    // 사진 만료로 방금 반려된 'late01'은 반려일이 오늘이라 30일 뒤에야 지운다
    assert.deepEqual(rows[0], { assessments: 0, photos: 0, rejected: 1, routes: 0 });
  });
});
