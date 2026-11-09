// SFR-083(가입 승인·반려) 인수 기준을 임시 DB·실제 Redis·메모리 사진 저장소로 확인한다.
// 대원이 실제 가입 API 로 신청한 뒤 관리자가 처리하는 흐름 그대로 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { withAuthContext } from '../../testing/auth.js';
import { WEB_ORIGIN } from '../../testing/hospitalWeb.js';
import { createMemoryStorage, createPhotoStore } from '../auth/photoStore.js';
import type { LoggedEvent } from '../realtime/eventLog.js';
import type { Realtime } from '../realtime/server.js';
import { signAdminAccessToken } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
// jpg 앞부분 + 표시 글자 (실제 사진 대신)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('CARD-PHOTO')]);
const PASSWORD = 'abcd1234';

interface Harness {
  pool: pg.Pool;
  app: () => ReturnType<typeof request>;
  admin: (method: 'get' | 'post', path: string, token?: string) => request.Test;
  storage: ReturnType<typeof createMemoryStorage>;
  published: LoggedEvent[];
  // 대원 앱으로 가입 신청. 신청 id 를 돌려준다
  apply: (loginId: string, name?: string) => Promise<number>;
  paramedicToken: string;
}

async function withAdminSignups(use: (h: Harness) => Promise<void>): Promise<void> {
  await withAuthContext(async (ctx) => {
    const storage = createMemoryStorage();
    const photos = createPhotoStore(storage, randomBytes(32));
    const published: LoggedEvent[] = [];
    const realtime = {
      publish: (events: LoggedEvent[]) => published.push(...events),
    } as unknown as Realtime;
    const server = createApp({
      logger,
      healthChecks: { db: ok, redis: ok },
      auth: ctx,
      photos,
      realtime,
      admin: {
        pool: ctx.pool,
        redis: ctx.redis,
        jwtKey: ctx.jwtKey,
        sessionHours: 14,
        allowedOrigins: [WEB_ORIGIN],
      },
    });
    await ctx.pool.query(
      "INSERT INTO agency (code, name, region) VALUES ('CN-SB-019', '천안서북소방서', '충청남도')",
    );
    const { rows } = await ctx.pool.query<{ id: string }>(
      "INSERT INTO admin (login_id, password_hash, name) VALUES ('kim', 'x', '김관리') RETURNING id",
    );
    const adminToken = await signAdminAccessToken(ctx.jwtKey, rows[0].id);
    const app = () => request(server);
    await use({
      pool: ctx.pool,
      storage,
      published,
      app,
      paramedicToken: '',
      admin: (method, path, token = adminToken) =>
        request(server)
          [method](`/api/v1${path}`)
          .set('Origin', WEB_ORIGIN)
          .set('Authorization', `Bearer ${token}`),
      apply: async (loginId, name = '최하늘') => {
        const req = app().post('/api/v1/auth/signup');
        const fields = {
          agencyCode: 'CN-SB-019',
          loginId,
          password: PASSWORD,
          name,
          rank: '소방사',
          safetyCenter: '성정안전센터',
          employeeNo: `E-${loginId}`,
          photoConsent: 'true',
        };
        for (const [k, v] of Object.entries(fields)) req.field(k, v);
        const res = await req.attach('photo', JPEG, 'card.jpg');
        assert.equal(res.status, 201);
        const { rows: s } = await ctx.pool.query<{ id: string }>(
          `SELECT s.id FROM signup_request s JOIN paramedic p ON p.id = s.paramedic_id
            WHERE p.login_id = $1 ORDER BY s.id DESC LIMIT 1`,
          [loginId],
        );
        return Number(s[0].id);
      },
    });
  });
}

const login = (h: Harness, loginId: string) =>
  h
    .app()
    .post('/api/v1/auth/login')
    .send({ loginId, password: PASSWORD, deviceId: `device-${loginId}` });

const auditActions = async (pool: pg.Pool) =>
  (await pool.query<{ action: string }>('SELECT action FROM admin_audit_log ORDER BY id')).rows.map(
    (r) => r.action,
  );

test('승인 대기 목록: 신청 정보를 먼저 낸 순서로 주고, 다시 낸 신청을 표시한다 (SFR-083)', async () => {
  await withAdminSignups(async (h) => {
    const first = await h.apply('newbie01', '최하늘');
    await h.apply('newbie02', '한바다');

    const res = await h.admin('get', '/admin/signups');
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2);
    const item = res.body.items[0];
    assert.equal(item.id, first);
    assert.equal(item.name, '최하늘');
    assert.equal(item.rank, '소방사');
    assert.equal(item.agencyCode, 'CN-SB-019');
    assert.equal(item.agencyName, '천안서북소방서');
    assert.equal(item.safetyCenter, '성정안전센터');
    assert.equal(item.employeeNo, 'E-newbie01');
    assert.equal(item.resubmitted, false);
    assert.ok(Date.parse(item.createdAt) && Date.parse(item.consentAt));
    // 사진 키 같은 내부 값은 내보내지 않는다
    assert.equal(JSON.stringify(res.body).includes('photo'), false);

    const page = await h.admin('get', '/admin/signups?limit=1');
    assert.equal(page.body.items.length, 1);
    const next = await h.admin('get', `/admin/signups?limit=1&cursor=${page.body.nextCursor}`);
    assert.equal(next.body.items[0].name, '한바다');
    assert.equal(next.body.nextCursor, null);
  });
});

test('사진을 열면 원본이 no-store 로 나오고 작업 이력에 열람 1건이 남는다 (SFR-083 인수 기준)', async () => {
  await withAdminSignups(async (h) => {
    const id = await h.apply('newbie01');

    const res = await h.admin('get', `/admin/signups/${id}/photo`).buffer(true);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-type'], /^image\/jpeg/);
    assert.deepEqual(Buffer.from(res.body), JPEG);

    const { rows } = await h.pool.query(
      "SELECT target_type, detail FROM admin_audit_log WHERE action = 'view_signup_photo'",
    );
    assert.deepEqual(rows, [
      { target_type: 'signup_request', detail: { targetName: '최하늘', reason: null } },
    ]);
    const log = await h.admin('get', '/admin/audit-logs');
    assert.equal(log.body.items[0].action, '공무원증 사진 열람');

    assert.equal((await h.admin('get', '/admin/signups/99999/photo')).status, 404);
  });
});

test('승인하면 계정이 승인되고, 사진이 지워지고, 확인자·시각만 남고, 다음 로그인부터 모든 기능을 쓴다 (SFR-083 인수 기준)', async () => {
  await withAdminSignups(async (h) => {
    const id = await h.apply('newbie01');
    // 승인 전에는 팀 만들기 같은 기능이 막힌다
    const before = (await login(h, 'newbie01')).body.tokens.accessToken;
    const blocked = await h.app().post('/api/v1/teams').set('Authorization', `Bearer ${before}`);
    assert.equal(blocked.status, 403);

    assert.equal((await h.admin('post', `/admin/signups/${id}/approve`)).status, 204);

    const { rows } = await h.pool.query(
      `SELECT s.photo_key, s.result, s.decided_by IS NOT NULL AS decided_by, s.decided_at IS NOT NULL AS decided_at,
              p.status
         FROM signup_request s JOIN paramedic p ON p.id = s.paramedic_id WHERE s.id = $1`,
      [id],
    );
    assert.deepEqual(rows[0], {
      photo_key: null,
      result: 'approved',
      decided_by: true,
      decided_at: true,
      status: 'approved',
    });
    assert.deepEqual(h.storage.keys(), [], '저장소의 사진 파일도 지운다');

    // 다음 로그인부터 승인된 계정
    const after = await login(h, 'newbie01');
    assert.equal(after.status, 200);
    const me = await h
      .app()
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${after.body.tokens.accessToken}`);
    assert.equal(me.body.status, 'approved');

    // 결과는 대원 개인 방으로 (푸시 포함), 사유는 없음
    const sent = h.published.find((e) => e.name === 'account.signup_result')!;
    assert.match(sent.room, /^paramedic:\d+$/);
    assert.deepEqual(sent.payload, { result: 'approved', reason: null });
    assert.ok((await auditActions(h.pool)).includes('approve_signup'));

    // 지워진 사진은 410, 이미 처리한 신청은 다시 처리하지 않는다
    const photo = await h.admin('get', `/admin/signups/${id}/photo`);
    assert.equal(photo.status, 410);
    assert.equal(photo.body.error.code, 'PHOTO_DELETED');
    const again = await h.admin('post', `/admin/signups/${id}/reject`).send({ reason: 'etc' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_RESPONDED');
    assert.equal((await h.admin('get', '/admin/signups')).body.items.length, 0);
  });
});

test("'사진 불명확'으로 반려하면 사진이 지워지고, 로그인하면 반려 사유가 보이고, 다시 신청할 수 있다 (SFR-083 인수 기준)", async () => {
  await withAdminSignups(async (h) => {
    const id = await h.apply('newbie01');

    const res = await h
      .admin('post', `/admin/signups/${id}/reject`)
      .send({ reason: 'photo_unclear' });
    assert.equal(res.status, 204);
    assert.deepEqual(h.storage.keys(), []);

    const token = (await login(h, 'newbie01')).body.tokens.accessToken;
    const me = await h.app().get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    assert.equal(me.body.status, 'rejected');
    assert.equal(me.body.rejectReason, 'photo_unclear');
    const sent = h.published.find((e) => e.name === 'account.signup_result')!;
    assert.deepEqual(sent.payload, { result: 'rejected', reason: 'photo_unclear' });
    const { rows } = await h.pool.query(
      "SELECT detail->>'reason' AS reason FROM admin_audit_log WHERE action = 'reject_signup'",
    );
    assert.equal(rows[0].reason, '사진 불명확');

    // 다시 신청하면 목록에 '다시 낸 신청'으로 올라온다
    const again = await h
      .app()
      .put('/api/v1/me/signup')
      .set('Authorization', `Bearer ${token}`)
      .field('agencyCode', 'CN-SB-019')
      .field('name', '최하늘')
      .field('rank', '소방사')
      .field('safetyCenter', '성정안전센터')
      .field('employeeNo', 'E-newbie01')
      .field('photoConsent', 'true')
      .attach('photo', JPEG, 'card.jpg');
    assert.equal(again.status, 200);
    const list = await h.admin('get', '/admin/signups');
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].resubmitted, true);
  });
});

test('반려: 사유가 없으면 422, 목록에 없는 사유면 400, 기타는 쓴 내용을 이력에 남긴다', async () => {
  await withAdminSignups(async (h) => {
    const id = await h.apply('newbie01');
    const missing = await h.admin('post', `/admin/signups/${id}/reject`).send({});
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.code, 'REASON_REQUIRED');
    assert.equal(
      (await h.admin('post', `/admin/signups/${id}/reject`).send({ reason: 'ugly' })).status,
      400,
    );
    // 실패한 요청은 아무것도 바꾸지 않았다
    assert.equal(h.storage.keys().length, 1);

    const res = await h
      .admin('post', `/admin/signups/${id}/reject`)
      .send({ reason: 'etc', etcText: '사번 확인 필요' });
    assert.equal(res.status, 204);
    const { rows } = await h.pool.query(
      `SELECT s.reject_reason, l.detail->>'reason' AS audit_reason
         FROM signup_request s, admin_audit_log l WHERE l.action = 'reject_signup'`,
    );
    assert.deepEqual(rows[0], { reject_reason: 'etc', audit_reason: '사번 확인 필요' });
  });
});

test('두 관리자가 동시에 승인·반려를 눌러도 한 명만 처리된다', async () => {
  await withAdminSignups(async (h) => {
    const id = await h.apply('newbie01');
    const [a, b] = await Promise.all([
      h.admin('post', `/admin/signups/${id}/approve`),
      h.admin('post', `/admin/signups/${id}/reject`).send({ reason: 'photo_unclear' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [204, 409]);
    const decided = (await auditActions(h.pool)).filter((x) => x.endsWith('_signup'));
    assert.equal(decided.length, 1);
    assert.equal(h.published.filter((e) => e.name === 'account.signup_result').length, 1);
  });
});

test('없는·탈퇴한 신청은 404, 관리자가 아니면 401 (SER-010)', async () => {
  await withAdminSignups(async (h) => {
    const id = await h.apply('newbie01');
    assert.equal((await h.admin('post', '/admin/signups/99999/approve')).status, 404);

    for (const [method, path] of [
      ['get', '/admin/signups'],
      ['get', `/admin/signups/${id}/photo`],
      ['post', `/admin/signups/${id}/approve`],
      ['post', `/admin/signups/${id}/reject`],
    ] as const) {
      const res = await h.app()[method](`/api/v1${path}`).set('Origin', WEB_ORIGIN);
      assert.equal(res.status, 401, `${method} ${path}`);
    }

    await h.pool.query("UPDATE paramedic SET status = 'withdrawn'");
    assert.equal((await h.admin('post', `/admin/signups/${id}/approve`)).status, 404);
    assert.equal((await h.admin('get', `/admin/signups/${id}/photo`)).status, 404);
    assert.equal((await h.admin('get', '/admin/signups')).body.items.length, 0);
    assert.deepEqual(await auditActions(h.pool), [], '열람·처리 기록이 남지 않았다');
  });
});
