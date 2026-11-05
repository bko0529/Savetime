// SFR-147(병원 등록 PC 관리)·SFR-100(관리자 알림 목록) 인수 기준을 임시 DB·실제 Redis 에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signAccessToken, signingKey } from '../auth/tokens.js';
import { WEB_ORIGIN, withHospitalWeb } from '../../testing/hospitalWeb.js';
import type { Realtime } from '../realtime/server.js';
import { notifyAdmin, notifyExpiringKeys } from './notifications.js';
import { releaseUnusedPcs } from './pcs.js';
import { signAdminAccessToken } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

interface Harness {
  pool: pg.Pool;
  jwtKey: Uint8Array;
  admin: (method: 'get' | 'post' | 'delete', path: string, token?: string) => request.Test;
  hw: (method: 'get' | 'post', path: string, cookie?: string) => request.Test;
  // 병원 계정을 발급하고 PC 를 등록해 둔다. PC 이름 → 쿠키
  hospitalWithPcs: (
    name: string,
    pcNames: string[],
  ) => Promise<{ id: number; cookies: Record<string, string> }>;
  // 실시간 서버 대신: 끊으라고 한 PC 와 '접속 중'으로 돌려줄 PC
  revokedPcs: string[];
  online: string[];
}

async function withAdminPcs(use: (h: Harness) => Promise<void>): Promise<void> {
  await withHospitalWeb(async (hospitalWeb) => {
    const { pool, redis } = hospitalWeb;
    const jwtKey = signingKey(randomBytes(32).toString('base64'));
    const revokedPcs: string[] = [];
    const online: string[] = [];
    const realtime = {
      revokeHospital: async () => {},
      revokePc: async (pc: { pcId: string }) => {
        revokedPcs.push(pc.pcId);
      },
      onlinePcIds: async () => online,
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
    const admin: Harness['admin'] = (method, path, token = adminToken) =>
      request(app)
        [method](`/api/v1${path}`)
        .set('Origin', WEB_ORIGIN)
        .set('Authorization', `Bearer ${token}`);
    const hw: Harness['hw'] = (method, path, cookie) => {
      const req = request(app)[method](`/api/v1${path}`).set('Origin', WEB_ORIGIN);
      return cookie ? req.set('Cookie', cookie) : req;
    };
    let seq = 0;
    await use({
      pool,
      jwtKey,
      admin,
      hw,
      revokedPcs,
      online,
      hospitalWithPcs: async (name, pcNames) => {
        seq += 1;
        const { rows: h } = await pool.query<{ id: string }>(
          `INSERT INTO hospital (public_id, name, lat, lng) VALUES ($1, $2, 36.8, 127.1) RETURNING id`,
          [`P${seq}`, name],
        );
        const id = Number(h[0].id);
        const { licenseKey } = (await admin('post', `/admin/hospitals/${id}/account`)).body;
        const cookies: Record<string, string> = {};
        for (const pcName of pcNames) {
          const reg = await hw('post', '/hw/pc/register').send({ licenseKey, pcName });
          assert.equal(reg.status, 201);
          const header = ([] as string[]).concat(reg.headers['set-cookie'] ?? []);
          cookies[pcName] = header.find((c) => c.startsWith('st_pc='))!.split(';')[0];
        }
        return { id, cookies };
      },
    });
  });
}

const pcIdOf = async (pool: pg.Pool, name: string) =>
  Number((await pool.query('SELECT id FROM hospital_pc WHERE name = $1', [name])).rows[0].id);

test('등록 PC 목록: PC 이름·등록 시각·마지막 사용 시각·접속 중을 최근 사용 순으로 (SFR-147)', async () => {
  await withAdminPcs(async (h) => {
    const a = await h.hospitalWithPcs('A병원', ['응급실 접수대', '야간 PC']);
    await h.pool.query(
      "UPDATE hospital_pc SET last_used_at = now() - interval '3 days' WHERE name = '야간 PC'",
    );
    h.online.push(String(await pcIdOf(h.pool, '응급실 접수대')));

    const res = await h.admin('get', `/admin/hospitals/${a.id}/pcs`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((p: { name: string; online: boolean }) => [p.name, p.online]),
      [
        ['응급실 접수대', true],
        ['야간 PC', false],
      ],
    );
    assert.ok(Date.parse(res.body[0].registeredAt));
    assert.ok(Date.parse(res.body[1].lastUsedAt) < Date.now() - 2 * 86_400_000);

    assert.equal((await h.admin('get', '/admin/hospitals/99999/pcs')).status, 404);
  });
});

test("'응급실 접수대'를 해제하면 그 PC 에서 병원 웹이 막히고 작업 이력에 1건 남는다 (SFR-147 인수 기준)", async () => {
  await withAdminPcs(async (h) => {
    const a = await h.hospitalWithPcs('A병원', ['응급실 접수대', '처치실']);
    const deskId = await pcIdOf(h.pool, '응급실 접수대');
    await h.pool.query(
      "INSERT INTO hospital_shift (pc_id, staff_name, alarm_on_at) SELECT id, '박서연', now() FROM hospital_pc",
    );

    const res = await h.admin('delete', `/admin/pcs/${deskId}`);
    assert.equal(res.status, 204);

    const desk = await h.hw('get', '/hw/session', a.cookies['응급실 접수대']);
    assert.equal(desk.body.error.code, 'PC_NOT_REGISTERED');
    // 다른 PC 는 그대로 쓴다
    assert.equal((await h.hw('get', '/hw/session', a.cookies['처치실'])).status, 200);
    const { rows: shifts } = await h.pool.query(
      `SELECT pc.name FROM hospital_shift s JOIN hospital_pc pc ON pc.id = s.pc_id
        WHERE s.alarm_on_at IS NOT NULL`,
    );
    assert.deepEqual(shifts, [{ name: '처치실' }], '해제한 PC 의 알림만 꺼진다');
    assert.deepEqual(h.revokedPcs, [String(deskId)]);

    const { rows: audit } = await h.pool.query(
      "SELECT target_type, target_id::int AS target_id, detail FROM admin_audit_log WHERE action = 'release_pc'",
    );
    assert.deepEqual(audit, [
      {
        target_type: 'hospital_pc',
        target_id: deskId,
        detail: { targetName: 'A병원 · 응급실 접수대', reason: null },
      },
    ]);
    const log = await h.admin('get', '/admin/audit-logs');
    assert.equal(log.body.items[0].action, '병원 PC 해제');

    // 목록에서 빠지고, 알림 목록에 해제가 보인다
    const list = await h.admin('get', `/admin/hospitals/${a.id}/pcs`);
    assert.deepEqual(
      list.body.map((p: { name: string }) => p.name),
      ['처치실'],
    );
    const notes = await h.admin('get', '/admin/notifications');
    assert.equal(notes.body.items[0].text, 'A병원 PC 해제 · 응급실 접수대');

    // 이미 해제한 PC 는 아무것도 바꾸지 않는다. 없는 PC 는 404
    assert.equal((await h.admin('delete', `/admin/pcs/${deskId}`)).status, 204);
    assert.equal(h.revokedPcs.length, 1);
    const { rows: count } = await h.pool.query(
      "SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'release_pc'",
    );
    assert.equal(count[0].n, 1);
    assert.equal((await h.admin('delete', '/admin/pcs/99999')).status, 404);
  });
});

test("'야간 PC'를 90일 동안 쓰지 않으면 자동 정리 때 해제된다 (SFR-147 인수 기준)", async () => {
  await withAdminPcs(async (h) => {
    await h.hospitalWithPcs('A병원', ['응급실 접수대', '야간 PC']);
    await h.pool.query(
      "UPDATE hospital_pc SET last_used_at = now() - interval '91 days' WHERE name = '야간 PC'",
    );
    // 정리 전에 쌓인 등록 알림은 읽어 두고, 정리가 새 알림을 남기는지 본다
    await h.pool.query(
      "UPDATE admin_notification SET read_at = now(), last_at = now() - interval '1 hour'",
    );

    assert.equal(await releaseUnusedPcs(h.pool), 1);

    const { rows } = await h.pool.query(
      'SELECT name, released_at IS NOT NULL AS released FROM hospital_pc ORDER BY id',
    );
    assert.deepEqual(rows, [
      { name: '응급실 접수대', released: false },
      { name: '야간 PC', released: true },
    ]);
    const notes = await h.admin('get', '/admin/notifications');
    assert.equal(notes.body.unread, 1);
    assert.equal(notes.body.items[0].text, 'A병원 PC 해제 · 야간 PC');

    // 다시 돌아도 더 풀 것이 없다
    assert.equal(await releaseUnusedPcs(h.pool), 0);
  });
});

test('알림 목록: 새 PC 등록이 알림이 되고, 30분 안 재발생은 횟수만 늘고, 열면 읽음 (SFR-100 인수 기준)', async () => {
  await withAdminPcs(async (h) => {
    await h.hospitalWithPcs('A병원', ['응급실 접수대']);
    let res = await h.admin('get', '/admin/notifications');
    assert.equal(res.status, 200);
    assert.equal(res.body.unread, 1);
    assert.deepEqual(
      res.body.items.map(
        (i: { kind: string; text: string; occurrences: number; read: boolean }) => [
          i.kind,
          i.text,
          i.occurrences,
          i.read,
        ],
      ),
      [['pc_change', 'A병원 PC 등록 · 응급실 접수대', 1, false]],
    );

    // 병상 수집 3회 연속 실패가 12분 뒤 또 생기면 새로 쌓지 않고 횟수가 2
    await notifyAdmin(h.pool, 'collect_fail', null);
    await h.pool.query(
      "UPDATE admin_notification SET last_at = now() - interval '12 minutes' WHERE kind = 'collect_fail'",
    );
    await notifyAdmin(h.pool, 'collect_fail', null);
    res = await h.admin('get', '/admin/notifications');
    const fail = res.body.items.find((i: { kind: string }) => i.kind === 'collect_fail');
    assert.equal(fail.text, '병상 수집 3회 연속 실패');
    assert.equal(fail.occurrences, 2);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.unread, 2);

    // 30분이 지나 생기면 새 알림
    await h.pool.query(
      "UPDATE admin_notification SET last_at = now() - interval '31 minutes' WHERE kind = 'collect_fail'",
    );
    await notifyAdmin(h.pool, 'collect_fail', null);
    res = await h.admin('get', '/admin/notifications');
    assert.equal(res.body.items.length, 3);
    assert.equal(res.body.unread, 3);

    // 열면 읽음, 읽지 않은 개수가 1 줄어든다. 두 번 열어도 그대로
    const target = res.body.items[0].id;
    assert.equal((await h.admin('post', `/admin/notifications/${target}/read`)).status, 204);
    assert.equal((await h.admin('post', `/admin/notifications/${target}/read`)).status, 204);
    res = await h.admin('get', '/admin/notifications');
    assert.equal(res.body.unread, 2);
    assert.equal(res.body.items.find((i: { id: number }) => i.id === target).read, true);
    assert.equal((await h.admin('post', '/admin/notifications/99999/read')).status, 404);
  });
});

test('알림 목록은 최근 발생 순으로 나눠 받는다', async () => {
  await withAdminPcs(async (h) => {
    for (const kind of ['collect_fail', 'signup', 'odd_pc'] as const) {
      await notifyAdmin(h.pool, kind, null);
    }
    // 가장 먼저 생긴 collect_fail 이 다시 생기면 맨 위로 올라온다
    await notifyAdmin(h.pool, 'collect_fail', null);

    const first = await h.admin('get', '/admin/notifications?limit=2');
    assert.deepEqual(
      first.body.items.map((i: { kind: string }) => i.kind),
      ['collect_fail', 'odd_pc'],
    );
    const next = await h.admin(
      'get',
      `/admin/notifications?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    assert.deepEqual(
      next.body.items.map((i: { kind: string }) => i.kind),
      ['signup'],
    );
    assert.equal(next.body.nextCursor, null);
    assert.equal((await h.admin('get', '/admin/notifications?cursor=x')).status, 400);
  });
});

test('라이선스 키 만료 30·7·1일 전에 한 번씩 알림이 쌓인다 (SFR-100 ④)', async () => {
  await withAdminPcs(async (h) => {
    await h.hospitalWithPcs('A병원', []);
    assert.equal(await notifyExpiringKeys(h.pool), 0, '1년 남은 키는 알림 없음');

    await h.pool.query("UPDATE license_key SET expires_at = now() + interval '20 days'");
    assert.equal(await notifyExpiringKeys(h.pool), 1);
    assert.equal(await notifyExpiringKeys(h.pool), 0, '같은 단계에서는 한 번만');

    // 7일 단계: 알림이 30분 넘게 지난 뒤 들어섰다고 본다
    await h.pool.query(
      "UPDATE admin_notification SET last_at = now() - interval '13 days', read_at = now() WHERE kind = 'key_expiring'",
    );
    await h.pool.query("UPDATE license_key SET expires_at = now() + interval '6 days'");
    assert.equal(await notifyExpiringKeys(h.pool), 1);

    const res = await h.admin('get', '/admin/notifications');
    const key = res.body.items.find((i: { kind: string }) => i.kind === 'key_expiring');
    assert.equal(key.text, 'A병원 라이선스 키 6일 뒤 만료');
    assert.equal(key.read, false);

    // 폐기한 키는 알림 대상이 아니다
    await h.pool.query("UPDATE admin_notification SET last_at = now() - interval '6 days'");
    await h.pool.query(
      "UPDATE license_key SET expires_at = now() + interval '12 hours', revoked_at = now()",
    );
    assert.equal(await notifyExpiringKeys(h.pool), 0);
  });
});

test('관리자 토큰이 없거나 대원 토큰이면 막는다 (SER-010)', async () => {
  await withAdminPcs(async (h) => {
    const paramedic = await signAccessToken(h.jwtKey, { paramedicId: '1', sessionVersion: 1 });
    for (const token of ['', paramedic]) {
      for (const [method, path] of [
        ['get', '/admin/hospitals/1/pcs'],
        ['delete', '/admin/pcs/1'],
        ['get', '/admin/notifications'],
        ['post', '/admin/notifications/1/read'],
      ] as const) {
        assert.equal((await h.admin(method, path, token)).status, 401, `${method} ${path}`);
      }
    }
  });
});
