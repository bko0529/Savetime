// SFR-116·147, SER-011 인수 기준을 임시 DB·실제 Redis 에서 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addHospitalWithKey, WEB_ORIGIN, withHospitalWeb } from '../../testing/hospitalWeb.js';
import { KEY_LOCK_SECONDS, MAX_KEY_FAILURES } from './routes.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

interface Harness {
  pool: pg.Pool;
  register: (body: object, origin?: string) => request.Test;
  session: (cookie?: string) => request.Test;
}

async function withApp(use: (h: Harness) => Promise<void>): Promise<void> {
  await withHospitalWeb(async (hospitalWeb) => {
    const app = createApp({ logger, healthChecks: { db: ok, redis: ok }, hospitalWeb });
    await use({
      pool: hospitalWeb.pool,
      register: (body, origin = WEB_ORIGIN) =>
        request(app).post('/api/v1/hw/pc/register').set('Origin', origin).send(body),
      session: (cookie) => {
        const req = request(app).get('/api/v1/hw/session').set('Origin', WEB_ORIGIN);
        return cookie ? req.set('Cookie', cookie) : req;
      },
    });
  });
}

// Set-Cookie 에서 'st_pc=값' 부분만 꺼내 다음 요청에 붙인다 (브라우저가 하는 일)
function pcCookie(res: request.Response): string {
  const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = header.find((c) => c.startsWith('st_pc='));
  assert.ok(cookie, 'st_pc 쿠키가 있어야 해요');
  return cookie.split(';')[0];
}

test('맞는 키와 PC 이름으로 등록하면 쿠키를 심고, 그 쿠키로 병원·PC 정보를 본다', async () => {
  await withApp(async ({ pool, register, session }) => {
    const { hospitalId, key } = await addHospitalWithKey(pool);

    const res = await register({ licenseKey: key, pcName: ' 응급실 접수대 ' });

    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { hospital: { id: Number(hospitalId), name: 'A병원' }, pcId: 1 });
    const setCookie = ([] as string[]).concat(res.headers['set-cookie']).join(';');
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
      assert.ok(setCookie.includes(attr), `${attr} 가 있어야 해요`);
    }
    // DB 에는 쿠키 값이 아니라 해시만 남는다
    const { rows } = await pool.query('SELECT name, token_hash FROM hospital_pc');
    assert.equal(rows[0].name, '응급실 접수대');
    assert.notEqual(rows[0].token_hash, pcCookie(res).slice('st_pc='.length));
    // PC 가 바뀌면 관리자 알림
    const { rows: notes } = await pool.query(
      "SELECT ref_id FROM admin_notification WHERE kind = 'pc_change'",
    );
    assert.equal(notes[0].ref_id, hospitalId);

    const me = await session(pcCookie(res));
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.hospital, { id: Number(hospitalId), name: 'A병원' });
    assert.deepEqual(me.body.pc, { id: 1, name: '응급실 접수대' });
    assert.equal(me.body.shift, null);
    assert.equal(me.body.paused, false);
    assert.ok(me.body.licenseDaysLeft >= 364 && me.body.licenseDaysLeft <= 366);
    assert.ok(me.body.serverNow);
  });
});

test('키는 소문자·띄어쓰기로 넣어도 맞는 키로 본다', async () => {
  await withApp(async ({ pool, register }) => {
    const { key } = await addHospitalWithKey(pool);
    const typed = key.toLowerCase().replaceAll('-', ' ');
    const res = await register({ licenseKey: typed, pcName: '접수대' });
    assert.equal(res.status, 201);
  });
});

test('쿠키가 없거나 모르는 쿠키면 PC_NOT_REGISTERED', async () => {
  await withApp(async ({ session }) => {
    assert.equal((await session()).body.error.code, 'PC_NOT_REGISTERED');
    const res = await session('st_pc=made-up');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'PC_NOT_REGISTERED');
  });
});

test('틀린 키 5번이면 그 뒤로는 맞는 키도 10분 동안 막는다 (SER-011)', async () => {
  await withApp(async ({ pool, register }) => {
    const { key } = await addHospitalWithKey(pool);
    for (let i = 0; i < MAX_KEY_FAILURES; i++) {
      const res = await register({ licenseKey: 'WRONG-KEY', pcName: '접수대' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_LICENSE');
    }

    const res = await register({ licenseKey: key, pcName: '접수대' });
    assert.equal(res.status, 423);
    assert.equal(res.body.error.code, 'TOO_MANY_ATTEMPTS');
    const wait = res.body.error.details.retryAfterSeconds;
    assert.ok(wait > KEY_LOCK_SECONDS - 10 && wait <= KEY_LOCK_SECONDS);
  });
});

test('맞게 넣으면 틀린 횟수가 처음부터 다시 센다', async () => {
  await withApp(async ({ pool, register }) => {
    const { key } = await addHospitalWithKey(pool);
    for (let i = 0; i < MAX_KEY_FAILURES - 1; i++) {
      await register({ licenseKey: 'WRONG', pcName: '접수대' });
    }
    assert.equal((await register({ licenseKey: key, pcName: '접수대' })).status, 201);
    for (let i = 0; i < MAX_KEY_FAILURES - 1; i++) {
      await register({ licenseKey: 'WRONG', pcName: '접수대' });
    }
    assert.equal((await register({ licenseKey: key, pcName: '처치실' })).status, 201);
  });
});

test('기간이 끝난 키는 LICENSE_EXPIRED 이고, 틀린 횟수로 세지 않는다', async () => {
  await withApp(async ({ pool, register }) => {
    const { key } = await addHospitalWithKey(pool, { expiresIn: '-1 day' });
    for (let i = 0; i < MAX_KEY_FAILURES + 1; i++) {
      const res = await register({ licenseKey: key, pcName: '접수대' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'LICENSE_EXPIRED');
    }
  });
});

test('3대가 차면 기존 PC 목록을 주고, 하나를 골라 바꾸면 그 PC 는 더 못 쓴다 (SFR-147)', async () => {
  await withApp(async ({ pool, register, session }) => {
    const { key } = await addHospitalWithKey(pool);
    const cookies: string[] = [];
    for (const name of ['접수대', '처치실', '간호사실']) {
      cookies.push(pcCookie(await register({ licenseKey: key, pcName: name })));
    }

    const full = await register({ licenseKey: key, pcName: '외래' });
    assert.equal(full.status, 409);
    assert.equal(full.body.error.code, 'PC_LIMIT_REACHED');
    const pcs = full.body.error.details.pcs;
    assert.deepEqual(pcs.map((pc: { name: string }) => pc.name).sort(), [
      '간호사실',
      '접수대',
      '처치실',
    ]);
    for (const pc of pcs) {
      assert.equal(typeof pc.id, 'number');
      assert.ok(!Number.isNaN(Date.parse(pc.lastUsedAt)));
    }

    const oldId = pcs.find((pc: { name: string }) => pc.name === '처치실').id;
    const replaced = await register({ licenseKey: key, pcName: '외래', replacePcId: oldId });
    assert.equal(replaced.status, 201);

    assert.equal((await session(cookies[1])).body.error.code, 'PC_NOT_REGISTERED');
    assert.equal((await session(cookies[0])).status, 200);
  });
});

test('다른 병원 PC 나 없는 PC 로는 바꿀 수 없다', async () => {
  await withApp(async ({ pool, register }) => {
    const { key } = await addHospitalWithKey(pool);
    const res = await register({ licenseKey: key, pcName: '외래', replacePcId: 999 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details.fields, ['replacePcId']);
  });
});

test('2대가 있을 때 두 PC 가 동시에 등록해도 3대를 넘지 않는다', async () => {
  await withApp(async ({ pool, register }) => {
    const { key } = await addHospitalWithKey(pool);
    await register({ licenseKey: key, pcName: '접수대' });
    await register({ licenseKey: key, pcName: '처치실' });

    const results = await Promise.all([
      register({ licenseKey: key, pcName: '외래1' }),
      register({ licenseKey: key, pcName: '외래2' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM hospital_pc WHERE released_at IS NULL',
    );
    assert.equal(rows[0].n, 3);
  });
});

test('90일 동안 안 쓴 PC 는 등록이 풀리고 자리가 빈다', async () => {
  await withApp(async ({ pool, register, session }) => {
    const { key } = await addHospitalWithKey(pool);
    const old = pcCookie(await register({ licenseKey: key, pcName: '접수대' }));
    await register({ licenseKey: key, pcName: '처치실' });
    await register({ licenseKey: key, pcName: '간호사실' });
    await pool.query(
      "UPDATE hospital_pc SET last_used_at = now() - interval '91 days' WHERE name = '접수대'",
    );

    assert.equal((await session(old)).body.error.code, 'PC_NOT_REGISTERED');
    assert.equal((await register({ licenseKey: key, pcName: '외래' })).status, 201);
  });
});

test('병원 키가 모두 만료·폐기되면 등록된 PC 도 LICENSE_EXPIRED (SFR-146)', async () => {
  await withApp(async ({ pool, register, session }) => {
    const { key } = await addHospitalWithKey(pool);
    const cookie = pcCookie(await register({ licenseKey: key, pcName: '접수대' }));
    await pool.query('UPDATE license_key SET revoked_at = now()');

    const res = await session(cookie);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'LICENSE_EXPIRED');
  });
});

test('허용되지 않은 사이트에서 온 요청은 막는다 (SER-008)', async () => {
  await withApp(async ({ pool, register }) => {
    const { key } = await addHospitalWithKey(pool);
    const res = await register({ licenseKey: key, pcName: '접수대' }, 'https://evil.example');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ORIGIN_NOT_ALLOWED');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM hospital_pc');
    assert.equal(rows[0].n, 0);
  });
});

test('입력 형식이 틀리면 칸 이름만 알려 준다', async () => {
  await withApp(async ({ register }) => {
    const res = await register({ licenseKey: 'K', pcName: 'x'.repeat(41) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details.fields, ['pcName']);
  });
});
