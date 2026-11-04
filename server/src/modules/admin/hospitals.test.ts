// SFR-123(병원 계정·키 발급·정지)·SFR-091(작업 이력) 인수 기준을 임시 DB·실제 Redis 에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signAccessToken, signingKey } from '../auth/tokens.js';
import { hashLicenseKey } from '../hospital-web/licenseKey.js';
import { WEB_ORIGIN, withHospitalWeb } from '../../testing/hospitalWeb.js';
import type { Realtime } from '../realtime/server.js';
import { signAdminAccessToken } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

interface Harness {
  pool: pg.Pool;
  adminToken: string;
  jwtKey: Uint8Array;
  admin: (method: 'get' | 'post', path: string, token?: string) => request.Test;
  hw: (method: 'get' | 'post', path: string, cookie?: string) => request.Test;
  addHospital: (name: string, publicId: string) => Promise<number>;
  // 실시간 서버 대신: 정지 때 부른 병원 id 를 모은다
  revoked: string[];
}

async function withAdminHospitals(use: (h: Harness) => Promise<void>): Promise<void> {
  await withHospitalWeb(async (hospitalWeb) => {
    const { pool, redis } = hospitalWeb;
    const jwtKey = signingKey(randomBytes(32).toString('base64'));
    const revoked: string[] = [];
    const realtime = {
      revokeHospital: async (hospitalId: string) => {
        revoked.push(hospitalId);
      },
    } as unknown as Realtime;
    const app = createApp({
      logger,
      healthChecks: { db: ok, redis: ok },
      hospitalWeb,
      realtime,
      admin: { pool, redis, jwtKey, sessionHours: 14, allowedOrigins: [WEB_ORIGIN] },
    });
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO admin (login_id, password_hash, name) VALUES ('kim', 'x', '김관리') RETURNING id",
    );
    const adminToken = await signAdminAccessToken(jwtKey, rows[0].id);
    await use({
      revoked,
      pool,
      adminToken,
      jwtKey,
      admin: (method, path, token = adminToken) =>
        request(app)
          [method](`/api/v1${path}`)
          .set('Origin', WEB_ORIGIN)
          .set('Authorization', `Bearer ${token}`),
      hw: (method, path, cookie) => {
        const req = request(app)[method](`/api/v1${path}`).set('Origin', WEB_ORIGIN);
        return cookie ? req.set('Cookie', cookie) : req;
      },
      addHospital: async (name, publicId) => {
        const { rows: h } = await pool.query<{ id: string }>(
          `INSERT INTO hospital (public_id, name, lat, lng) VALUES ($1, $2, 36.8, 127.1) RETURNING id`,
          [publicId, name],
        );
        return Number(h[0].id);
      },
    });
  });
}

function pcCookie(res: request.Response): string {
  const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return header.find((c) => c.startsWith('st_pc='))!.split(';')[0];
}

async function auditRows(pool: pg.Pool) {
  const { rows } = await pool.query(
    'SELECT action, target_type, target_id::int AS target_id, detail FROM admin_audit_log ORDER BY id',
  );
  return rows;
}

test('병원을 골라 발급하면 계정과 키가 만들어지고, 키 전체는 이 응답에서 한 번만 준다 (SFR-123)', async () => {
  await withAdminHospitals(async (h) => {
    const id = await h.addHospital('A대학교병원', 'A1');

    const res = await h.admin('post', `/admin/hospitals/${id}/account`);

    assert.equal(res.status, 201);
    assert.match(res.body.licenseKey, /^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const days = (Date.parse(res.body.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 364 && days <= 366, '유효 1년');

    // DB 에는 해시와 앞 4자리만 있다
    const { rows } = await h.pool.query('SELECT key_hash, key_prefix FROM license_key');
    assert.equal(rows[0].key_hash, hashLicenseKey(res.body.licenseKey));
    assert.equal(rows[0].key_prefix, res.body.licenseKey.slice(0, 4));
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(res.body.licenseKey));

    // 다시 열면 키는 앞 4자리만 (인수 기준)
    const list = await h.admin('get', '/admin/hospitals?q=A대학교');
    assert.deepEqual(list.body.items[0].license.prefix, res.body.licenseKey.slice(0, 4));
    assert.equal(list.body.items[0].accountActive, true);
    assert.doesNotMatch(JSON.stringify(list.body), new RegExp(res.body.licenseKey));

    // 작업 이력에 1건 (인수 기준, SFR-091)
    assert.deepEqual(await auditRows(h.pool), [
      {
        action: 'issue_account',
        target_type: 'hospital',
        target_id: id,
        detail: { targetName: 'A대학교병원', reason: null },
      },
    ]);
  });
});

test('이미 발급한 병원은 ACCOUNT_EXISTS, 없는 병원은 404, 두 관리자가 동시에 눌러도 한 번만', async () => {
  await withAdminHospitals(async (h) => {
    const id = await h.addHospital('B병원', 'B1');
    const [first, second] = await Promise.all([
      h.admin('post', `/admin/hospitals/${id}/account`),
      h.admin('post', `/admin/hospitals/${id}/account`),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const again = await h.admin('post', `/admin/hospitals/${id}/account`);
    assert.equal(again.body.error.code, 'ACCOUNT_EXISTS');
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM license_key');
    assert.equal(rows[0].n, 1);
    assert.equal((await auditRows(h.pool)).length, 1);

    const missing = await h.admin('post', '/admin/hospitals/99999/account');
    assert.equal(missing.status, 404);
  });
});

test('발급한 키로 PC 를 등록하고, 정지하면 그 병원 PC 가 모두 막힌다 (SFR-123 인수 기준)', async () => {
  await withAdminHospitals(async (h) => {
    const id = await h.addHospital('A병원', 'A1');
    const { licenseKey } = (await h.admin('post', `/admin/hospitals/${id}/account`)).body;
    const cookies = [];
    for (const pcName of ['접수대', '처치실']) {
      const reg = await h.hw('post', '/hw/pc/register').send({ licenseKey, pcName });
      assert.equal(reg.status, 201);
      cookies.push(pcCookie(reg));
    }
    // 알림 켠 근무가 있으면 정지 때 꺼서 요청 대상에서 뺀다
    await h.pool.query(
      "INSERT INTO hospital_shift (pc_id, staff_name, alarm_on_at) SELECT id, '박서연', now() FROM hospital_pc",
    );

    const suspend = await h.admin('post', `/admin/hospitals/${id}/suspend`);
    assert.equal(suspend.status, 204);

    for (const cookie of cookies) {
      const res = await h.hw('get', '/hw/session', cookie);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'ACCOUNT_SUSPENDED');
    }
    const reg = await h.hw('post', '/hw/pc/register').send({ licenseKey, pcName: '원무과' });
    assert.equal(reg.body.error.code, 'ACCOUNT_SUSPENDED');
    const { rows } = await h.pool.query(
      'SELECT count(*)::int AS n FROM hospital_shift WHERE alarm_on_at IS NOT NULL',
    );
    assert.equal(rows[0].n, 0);

    // 이미 정지된 병원을 또 정지해도 이력은 한 번만
    assert.equal((await h.admin('post', `/admin/hospitals/${id}/suspend`)).status, 204);
    assert.deepEqual(
      (await auditRows(h.pool)).map((r) => r.action),
      ['issue_account', 'suspend_hospital'],
    );
    const list = await h.admin('get', '/admin/hospitals');
    assert.equal(list.body.items[0].accountActive, false);
    assert.equal(list.body.items[0].pcCount, 2);
  });
});

test('병원 검색: 이름 일부로 찾고, PC 수·키 정보를 주고, 나눠 받는다', async () => {
  await withAdminHospitals(async (h) => {
    await h.addHospital('천안 A병원', 'H1');
    const b = await h.addHospital('천안 B병원', 'H2');
    await h.addHospital('아산 C병원', 'H3');
    await h.addHospital('100%_병원', 'H4');
    await h.admin('post', `/admin/hospitals/${b}/account`);

    const page1 = await h.admin('get', '/admin/hospitals?q=천안&limit=1');
    assert.equal(page1.status, 200);
    assert.deepEqual(
      page1.body.items.map((i: { name: string }) => i.name),
      ['천안 A병원'],
    );
    assert.equal(page1.body.items[0].license, null);
    assert.equal(page1.body.items[0].pcLimit, 3);
    const page2 = await h.admin(
      'get',
      `/admin/hospitals?q=천안&limit=1&cursor=${page1.body.nextCursor}`,
    );
    assert.equal(page2.body.items[0].name, '천안 B병원');
    assert.ok(page2.body.items[0].license.daysLeft >= 364);
    assert.equal(page2.body.nextCursor, null);

    // % · _ 는 글자 그대로 찾는다
    const literal = await h.admin('get', `/admin/hospitals?q=${encodeURIComponent('%_')}`);
    assert.deepEqual(
      literal.body.items.map((i: { name: string }) => i.name),
      ['100%_병원'],
    );
  });
});

test('작업 이력: 최신순으로 작업자·작업·대상·사유·시각을 주고, 고치거나 지울 수 없다 (SFR-091)', async () => {
  await withAdminHospitals(async (h) => {
    const a = await h.addHospital('A병원', 'A1');
    const b = await h.addHospital('B병원', 'B1');
    await h.admin('post', `/admin/hospitals/${a}/account`);
    await h.admin('post', `/admin/hospitals/${b}/account`);
    await h.admin('post', `/admin/hospitals/${a}/suspend`);

    const res = await h.admin('get', '/admin/audit-logs?limit=2');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((i: { action: string; target: string; admin: string }) => [
        i.admin,
        i.action,
        i.target,
      ]),
      [
        ['김관리', '병원 계정 정지', 'A병원'],
        ['김관리', '병원 계정 발급', 'B병원'],
      ],
    );
    assert.ok(Date.parse(res.body.items[0].at));
    const next = await h.admin('get', `/admin/audit-logs?limit=2&cursor=${res.body.nextCursor}`);
    assert.deepEqual(
      next.body.items.map((i: { target: string }) => i.target),
      ['A병원'],
    );
    assert.equal(next.body.nextCursor, null);

    const future = await h.admin(
      'get',
      `/admin/audit-logs?from=${encodeURIComponent('2999-01-01T00:00:00Z')}`,
    );
    assert.deepEqual(future.body.items, []);

    await h.pool.query("UPDATE admin_audit_log SET action = 'x'");
    await h.pool.query('DELETE FROM admin_audit_log');
    assert.equal((await auditRows(h.pool)).length, 3);
  });
});

test('관리자 토큰이 없거나 대원 토큰이면 막는다 (SER-010)', async () => {
  await withAdminHospitals(async (h) => {
    const id = await h.addHospital('A병원', 'A1');
    const paramedic = await signAccessToken(h.jwtKey, { paramedicId: '1', sessionVersion: 1 });
    for (const token of ['', paramedic]) {
      for (const [method, path] of [
        ['get', '/admin/hospitals'],
        ['post', `/admin/hospitals/${id}/account`],
        ['post', `/admin/hospitals/${id}/suspend`],
        ['get', '/admin/audit-logs'],
      ] as const) {
        const res = await h.admin(method, path, token);
        assert.equal(res.status, 401, `${method} ${path}`);
      }
    }
    assert.equal((await auditRows(h.pool)).length, 0);
  });
});

// 병원 계정을 발급하고 PC 를 여러 대 등록해 둔다 (SFR-146 테스트 준비)
async function hospitalWithPcs(h: Harness, name: string, pcNames: string[]) {
  const id = await h.addHospital(name, `${name}-id`);
  const { licenseKey } = (await h.admin('post', `/admin/hospitals/${id}/account`)).body;
  const cookies: string[] = [];
  for (const pcName of pcNames) {
    const reg = await h.hw('post', '/hw/pc/register').send({ licenseKey, pcName });
    assert.equal(reg.status, 201);
    cookies.push(pcCookie(reg));
  }
  const { rows } = await h.pool.query<{ id: string }>(
    'SELECT id FROM license_key WHERE hospital_id = $1',
    [id],
  );
  return { id, licenseKey: licenseKey as string, keyId: rows[0].id, cookies };
}

test('키를 폐기하면 등록 PC 2대 모두 막히고, 새 키는 만들어지지 않는다 (SFR-146 인수 기준)', async () => {
  await withAdminHospitals(async (h) => {
    const a = await hospitalWithPcs(h, 'A병원', ['접수대', '처치실']);
    await h.pool.query(
      "INSERT INTO hospital_shift (pc_id, staff_name, alarm_on_at) SELECT id, '박서연', now() FROM hospital_pc",
    );

    const res = await h
      .admin('post', `/admin/license-keys/${a.keyId}/revoke`)
      .send({ reason: '병원 탈퇴' });
    assert.equal(res.status, 204);

    // 두 PC 모두 등록이 풀려 키 입력 화면으로 돌아간다
    for (const cookie of a.cookies) {
      const s = await h.hw('get', '/hw/session', cookie);
      assert.equal(s.status, 401);
      assert.equal(s.body.error.code, 'PC_NOT_REGISTERED');
    }
    // 폐기한 키로는 다시 등록할 수 없다
    const reg = await h.hw('post', '/hw/pc/register').send({ licenseKey: a.licenseKey, pcName: '원무과' });
    assert.equal(reg.body.error.code, 'INVALID_LICENSE');

    const { rows: keys } = await h.pool.query(
      'SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM license_key',
    );
    assert.deepEqual(keys, [{ revoked: true, revoke_reason: '병원 탈퇴' }]);
    const { rows: shifts } = await h.pool.query(
      'SELECT count(*)::int AS n FROM hospital_shift WHERE alarm_on_at IS NOT NULL',
    );
    assert.equal(shifts[0].n, 0, '알림 켠 근무가 꺼져 요청 대상에서 빠진다');

    // 관리자 목록에는 쓰는 키가 없다고 나온다
    const list = await h.admin('get', '/admin/hospitals');
    assert.equal(list.body.items[0].license, null);
    assert.equal(list.body.items[0].pcCount, 0);

    // 작업 이력에 사유와 함께, 실시간으로 탭도 끊는다
    const audit = await auditRows(h.pool);
    assert.deepEqual(audit.at(-1), {
      action: 'revoke_key',
      target_type: 'hospital',
      target_id: a.id,
      detail: { targetName: 'A병원', reason: '병원 탈퇴' },
    });
    assert.deepEqual(h.revoked, [String(a.id)]);

    // 이미 폐기된 키를 또 폐기해도 이력·실시간 호출은 한 번만
    const again = await h
      .admin('post', `/admin/license-keys/${a.keyId}/revoke`)
      .send({ reason: '병원 탈퇴' });
    assert.equal(again.status, 204);
    assert.equal((await auditRows(h.pool)).length, audit.length);
    assert.deepEqual(h.revoked, [String(a.id)]);
  });
});

test('키를 재발급하면 PC 3대 모두 막히고, 새 키가 한 번만 나오며 작업 이력에 사유가 남는다 (SFR-146 인수 기준)', async () => {
  await withAdminHospitals(async (h) => {
    const a = await hospitalWithPcs(h, 'A병원', ['접수대', '처치실', '원무과']);

    const res = await h
      .admin('post', `/admin/hospitals/${a.id}/license-keys`)
      .send({ reason: '키 유출 의심' });
    assert.equal(res.status, 201);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body.licenseKey, /^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
    assert.notEqual(res.body.licenseKey, a.licenseKey);

    for (const cookie of a.cookies) {
      const s = await h.hw('get', '/hw/session', cookie);
      assert.equal(s.body.error.code, 'PC_NOT_REGISTERED');
    }
    // 옛 키는 못 쓰고 새 키로는 다시 등록된다
    const old = await h.hw('post', '/hw/pc/register').send({ licenseKey: a.licenseKey, pcName: '접수대' });
    assert.equal(old.body.error.code, 'INVALID_LICENSE');
    const fresh = await h
      .hw('post', '/hw/pc/register')
      .send({ licenseKey: res.body.licenseKey, pcName: '접수대' });
    assert.equal(fresh.status, 201);

    // DB 에는 새 키의 해시만, 키 전체는 어디에도 없다
    const { rows: keys } = await h.pool.query(
      'SELECT key_hash, revoked_at IS NOT NULL AS revoked, revoke_reason FROM license_key ORDER BY id',
    );
    assert.deepEqual(
      keys.map((k) => [k.revoked, k.revoke_reason]),
      [
        [true, '키 유출 의심'],
        [false, null],
      ],
    );
    assert.equal(keys[1].key_hash, hashLicenseKey(res.body.licenseKey));
    const list = await h.admin('get', '/admin/hospitals');
    assert.equal(list.body.items[0].license.prefix, res.body.licenseKey.slice(0, 4));
    assert.doesNotMatch(JSON.stringify(list.body), new RegExp(res.body.licenseKey));

    const audit = await auditRows(h.pool);
    assert.deepEqual(audit.at(-1), {
      action: 'reissue_key',
      target_type: 'hospital',
      target_id: a.id,
      detail: { targetName: 'A병원', reason: '키 유출 의심' },
    });
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(res.body.licenseKey));
    assert.deepEqual(h.revoked, [String(a.id)]);
  });
});

test('폐기·재발급: 사유가 없으면 422, 60자 넘으면 400, 없는 키·병원·발급 전 병원은 404', async () => {
  await withAdminHospitals(async (h) => {
    const a = await hospitalWithPcs(h, 'A병원', ['접수대']);
    const notIssued = await h.addHospital('B병원', 'B1');

    for (const body of [{}, { reason: '   ' }]) {
      const r1 = await h.admin('post', `/admin/license-keys/${a.keyId}/revoke`).send(body);
      assert.equal(r1.status, 422);
      assert.equal(r1.body.error.code, 'REASON_REQUIRED');
      const r2 = await h.admin('post', `/admin/hospitals/${a.id}/license-keys`).send(body);
      assert.equal(r2.body.error.code, 'REASON_REQUIRED');
    }
    const tooLong = await h
      .admin('post', `/admin/license-keys/${a.keyId}/revoke`)
      .send({ reason: '가'.repeat(61) });
    assert.equal(tooLong.status, 400);

    const missingKey = await h.admin('post', '/admin/license-keys/99999/revoke').send({ reason: 'x' });
    assert.equal(missingKey.status, 404);
    const missingHospital = await h
      .admin('post', '/admin/hospitals/99999/license-keys')
      .send({ reason: 'x' });
    assert.equal(missingHospital.status, 404);
    const beforeAccount = await h
      .admin('post', `/admin/hospitals/${notIssued}/license-keys`)
      .send({ reason: 'x' });
    assert.equal(beforeAccount.status, 404);

    // 실패한 요청은 아무것도 바꾸지 않았다
    assert.equal((await h.hw('get', '/hw/session', a.cookies[0])).status, 200);
    assert.equal((await auditRows(h.pool)).length, 1);

    // 관리자가 아니면 막는다 (SER-010)
    const paramedic = await signAccessToken(h.jwtKey, { paramedicId: '1', sessionVersion: 1 });
    const noAuth = await h
      .admin('post', `/admin/license-keys/${a.keyId}/revoke`, paramedic)
      .send({ reason: 'x' });
    assert.equal(noAuth.status, 401);
  });
});

test('두 관리자가 동시에 재발급해도 살아 있는 키는 하나만 남는다 (SFR-146)', async () => {
  await withAdminHospitals(async (h) => {
    const a = await hospitalWithPcs(h, 'A병원', ['접수대']);
    const [r1, r2] = await Promise.all([
      h.admin('post', `/admin/hospitals/${a.id}/license-keys`).send({ reason: '분실' }),
      h.admin('post', `/admin/hospitals/${a.id}/license-keys`).send({ reason: '분실' }),
    ]);
    assert.deepEqual([r1.status, r2.status], [201, 201]);
    const { rows } = await h.pool.query(
      'SELECT count(*)::int AS n FROM license_key WHERE revoked_at IS NULL',
    );
    assert.equal(rows[0].n, 1);
  });
});

test('정지하면 커밋 뒤 실시간 서버에 그 병원 탭을 끊게 하고, 이미 정지된 병원은 다시 부르지 않는다', async () => {
  await withAdminHospitals(async (h) => {
    const id = await h.addHospital('A병원', 'A1');
    await h.admin('post', `/admin/hospitals/${id}/account`);
    assert.equal((await h.admin('post', `/admin/hospitals/${id}/suspend`)).status, 204);
    assert.equal((await h.admin('post', `/admin/hospitals/${id}/suspend`)).status, 204);
    assert.deepEqual(h.revoked, [String(id)]);
  });
});
