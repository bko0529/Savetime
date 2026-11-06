// SFR-017 소속 확인 가입 · SFR-022 승인 전 계정 · SFR-083 반려 뒤 다시 신청 · SER-015 사진 암호화를 임시 DB와 실제 Redis로 확인한다.
// 저장소는 메모리 저장소로 바꿔 끼운다 (실제 S3 호환 저장소 확인은 S3_ENDPOINT 가 있을 때만 맨 아래 테스트).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import {
  createMemoryStorage,
  createPhotoStore,
  createS3Storage,
  decryptPhoto,
  encryptPhoto,
  type PhotoStore,
} from './photoStore.js';
import type { AuthContext } from './session.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const KEY = randomBytes(32);
const MARK = 'GONGMUWON-PHOTO-1234';
// jpg 앞부분(FF D8 FF) + 표시 글자. 저장소에 이 글자가 그대로 보이면 암호화가 안 된 것
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MARK)]);

function appWith(ctx: AuthContext, photos?: PhotoStore) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx, photos });
}

async function addAgency(pool: pg.Pool) {
  await pool.query(
    `INSERT INTO agency (code, name, region) VALUES ('CN-SB-019', '천안서북소방서', '충청남도')`,
  );
}

const FIELDS = {
  agencyCode: 'CN-SB-019',
  loginId: 'newbie01',
  password: 'abcd1234',
  name: '최하늘',
  rank: '소방사',
  safetyCenter: '성정안전센터',
  employeeNo: 'E-2026-77',
  photoConsent: 'true',
};

function signup(
  app: ReturnType<typeof appWith>,
  fields: Record<string, string> = FIELDS,
  photo: Buffer | null = JPEG,
) {
  const req = request(app).post('/api/v1/auth/signup');
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  if (photo) req.attach('photo', photo, 'card.jpg');
  return req;
}

test('사진은 AES-256-GCM 으로 암호화되고 같은 키로만 풀린다 (SER-015)', () => {
  const stored = encryptPhoto(KEY, JPEG);
  assert.ok(!stored.includes(Buffer.from(MARK)));
  assert.deepEqual(decryptPhoto(KEY, stored), JPEG);
  assert.throws(() => decryptPhoto(randomBytes(32), stored));
  // 한 바이트만 바뀌어도 인증 태그 때문에 풀리지 않는다
  const tampered = Buffer.from(stored);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptPhoto(KEY, tampered));
});

test('소속기관 코드 확인: 있으면 이름, 없으면 404 AGENCY_NOT_FOUND', async () => {
  await withAuthContext(async (ctx) => {
    await addAgency(ctx.pool);
    const app = appWith(ctx);
    const found = await request(app).get('/api/v1/agencies/CN-SB-019');
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, { code: 'CN-SB-019', name: '천안서북소방서' });
    const missing = await request(app).get('/api/v1/agencies/NOPE-1');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'AGENCY_NOT_FOUND');
  });
});

test('가입 신청: 승인 대기 계정 + 암호화한 사진 + 관리자 알림, 로그인하면 승인 대기 화면만 (SFR-017·022)', async () => {
  await withAuthContext(async (ctx) => {
    await addAgency(ctx.pool);
    const storage = createMemoryStorage();
    const photos = createPhotoStore(storage, KEY);
    const app = appWith(ctx, photos);

    const res = await signup(app);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'pending');
    assert.ok(!Number.isNaN(Date.parse(res.body.appliedAt)));
    // 응답에 사진·비밀번호가 없다
    assert.ok(!JSON.stringify(res.body).includes(MARK));

    const { rows } = await ctx.pool.query(
      `SELECT p.status, p.name, a.code, s.photo_key, s.consent_at IS NOT NULL AS consented, p.password_hash
         FROM paramedic p JOIN agency a ON a.id = p.agency_id JOIN signup_request s ON s.paramedic_id = p.id
        WHERE p.login_id = 'newbie01'`,
    );
    const row = rows[0];
    assert.deepEqual(
      [row.status, row.name, row.code, row.consented],
      ['pending', '최하늘', 'CN-SB-019', true],
    );
    assert.ok(row.password_hash.startsWith('$argon2id$'));

    // 저장소에는 암호문만 있고, 키에는 대원 정보가 없다
    assert.deepEqual(storage.keys(), [row.photo_key]);
    assert.ok(/^signup\/[0-9a-f-]{36}$/.test(row.photo_key));
    assert.ok(!storage.raw(row.photo_key)!.includes(Buffer.from(MARK)));
    assert.deepEqual(await photos.read(row.photo_key), JPEG);

    const { rows: notes } = await ctx.pool.query('SELECT kind FROM admin_notification');
    assert.deepEqual(notes, [{ kind: 'signup' }]);

    // 로그인은 되지만 승인 전이라 다른 기능은 막힌다 (SFR-022)
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ loginId: 'newbie01', password: 'abcd1234', deviceId: 'phone-1' });
    assert.equal(login.status, 200);
    const token = login.body.tokens.accessToken;
    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    assert.equal(me.body.status, 'pending');
    assert.ok(me.body.appliedAt);
    const blocked = await request(app)
      .get('/api/v1/teams/current')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(blocked.status, 403);
  });
});

test('가입 신청 거절: 동의·사진·형식·크기·소속·아이디·비밀번호, 저장소 없음은 503. 어느 경우도 사진이 남지 않는다', async () => {
  await withAuthContext(async (ctx) => {
    await addAgency(ctx.pool);
    await addParamedic(ctx.pool, { loginId: 'taken01' });
    const storage = createMemoryStorage();
    const app = appWith(ctx, createPhotoStore(storage, KEY));
    const code = async (r: request.Test) => {
      const res = await r;
      return [res.status, res.body.error?.code];
    };

    assert.deepEqual(await code(signup(app, { ...FIELDS, photoConsent: 'false' })), [
      422,
      'CONSENT_REQUIRED',
    ]);
    assert.deepEqual(await code(signup(app, FIELDS, null)), [400, 'VALIDATION_FAILED']);
    assert.deepEqual(await code(signup(app, FIELDS, Buffer.from('not an image'))), [
      400,
      'VALIDATION_FAILED',
    ]);
    // 5MB 넘는 사진
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
    assert.deepEqual(await code(signup(app, FIELDS, big)), [400, 'VALIDATION_FAILED']);

    // 같은 주소에서 10분에 5번까지라, 여기서 횟수를 비우고 나머지 경우를 이어서 본다
    await ctx.redis.del('signup:ip:::ffff:127.0.0.1', 'signup:ip:127.0.0.1', 'signup:ip:::1');
    assert.deepEqual(await code(signup(app, { ...FIELDS, agencyCode: 'NOPE-1' })), [
      404,
      'AGENCY_NOT_FOUND',
    ]);
    assert.deepEqual(await code(signup(app, { ...FIELDS, loginId: 'taken01' })), [
      409,
      'LOGIN_ID_TAKEN',
    ]);
    assert.deepEqual(await code(signup(app, { ...FIELDS, password: 'short' })), [
      400,
      'VALIDATION_FAILED',
    ]);
    assert.deepEqual(await code(signup(appWith(ctx), FIELDS)), [503, 'PHOTO_STORAGE_UNAVAILABLE']);

    assert.deepEqual(storage.keys(), []);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM signup_request');
    assert.equal(rows[0].n, 0);
  });
});

test('같은 아이디로 동시에 신청해도 계정은 1개, 실패한 쪽 사진은 지운다', async () => {
  await withAuthContext(async (ctx) => {
    await addAgency(ctx.pool);
    const storage = createMemoryStorage();
    const app = appWith(ctx, createPhotoStore(storage, KEY));
    const results = await Promise.all([signup(app), signup(app)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(storage.keys().length, 1);
    const { rows } = await ctx.pool.query('SELECT photo_key FROM signup_request');
    assert.deepEqual(storage.keys(), [rows[0].photo_key]);
  });
});

test('같은 주소에서 10분에 5번까지만 신청할 수 있다', async () => {
  await withAuthContext(async (ctx) => {
    await addAgency(ctx.pool);
    const app = appWith(ctx, createPhotoStore(createMemoryStorage(), KEY));
    for (let i = 0; i < 5; i += 1) {
      const res = await signup(app, { ...FIELDS, photoConsent: 'false' });
      assert.equal(res.status, 422);
    }
    const sixth = await signup(app);
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error.code, 'TOO_MANY_REQUESTS');
  });
});

async function loginAs(ctx: AuthContext, app: ReturnType<typeof appWith>, loginId: string) {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `d-${loginId}` });
  return res.body.tokens.accessToken as string;
}

test('반려된 계정은 고쳐서 다시 신청하면 승인 대기로, 다른 상태는 409 SIGNUP_NOT_REJECTED (SFR-083)', async () => {
  await withAuthContext(async (ctx) => {
    await addAgency(ctx.pool);
    const storage = createMemoryStorage();
    const app = appWith(ctx, createPhotoStore(storage, KEY));
    const id = await addParamedic(ctx.pool, { loginId: 'again01', status: 'rejected' });
    await ctx.pool.query(
      `INSERT INTO signup_request (paramedic_id, photo_key, consent_at, result, reject_reason, decided_at)
       VALUES ($1, NULL, now(), 'rejected', 'photo_unclear', now())`,
      [id],
    );
    const token = await loginAs(ctx, app, 'again01');
    // 다시 신청에는 아이디·비밀번호가 없다
    const profile: Record<string, string> = { ...FIELDS };
    delete profile.loginId;
    delete profile.password;
    const put = (t: string) => {
      const req = request(app).put('/api/v1/me/signup').set('Authorization', `Bearer ${t}`);
      for (const [k, v] of Object.entries(profile)) req.field(k, v);
      return req.attach('photo', JPEG, 'card.jpg');
    };

    const res = await put(token);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pending');
    const { rows } = await ctx.pool.query(
      `SELECT p.status, p.name, (SELECT count(*)::int FROM signup_request WHERE paramedic_id = p.id) AS n
         FROM paramedic p WHERE p.id = $1`,
      [id],
    );
    assert.deepEqual(rows[0], { status: 'pending', name: '최하늘', n: 2 });
    assert.equal(storage.keys().length, 1);
    // 다음 요청부터 바로 승인 대기로 보인다
    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    assert.equal(me.body.status, 'pending');
    assert.equal(me.body.rejectReason, null);

    // 이미 승인 대기면 다시 낼 수 없다
    const again = await put(token);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'SIGNUP_NOT_REJECTED');
    assert.equal(storage.keys().length, 1);
  });
});

// 개발 저장소(docker compose 의 S3Mock)가 있을 때만: 실제로 올리고 읽고 지운다
test(
  'S3 호환 저장소에 암호문을 올리고 읽고 지운다 (S3_ENDPOINT 가 있을 때)',
  { skip: !process.env.S3_ENDPOINT },
  async () => {
    const storage = createS3Storage({
      endpoint: process.env.S3_ENDPOINT!,
      region: process.env.S3_REGION || 'ap-northeast-2',
      bucket: process.env.S3_BUCKET || 'savetime-photos',
      accessKeyId: process.env.S3_ACCESS_KEY || 'dev',
      secretAccessKey: process.env.S3_SECRET_KEY || 'dev',
    });
    const photos = createPhotoStore(storage, KEY);
    const key = await photos.save(JPEG);
    assert.ok(!(await storage.get(key))!.includes(Buffer.from(MARK)));
    assert.deepEqual(await photos.read(key), JPEG);
    await photos.remove(key);
    assert.equal(await photos.read(key), null);
  },
);
