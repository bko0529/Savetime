// 이송 건 흐름 테스트용 장면: 김도윤·이하준 한 팀이 B·C·D병원에 요청했고, B·C는 승인, D는 대기 중.
// 확정·취소·도착 테스트가 같이 쓴다. 실시간 서버 없이 REST만 띄우고, 이벤트는 event_log로 확인한다.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../app.js';
import type { AuthContext } from '../modules/auth/session.js';
import { addParamedic, TEST_PASSWORD } from './auth.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
export const ORIGIN = { lat: 36.815, lng: 127.1139 };

export function appFor(ctx: AuthContext) {
  return createApp({ logger, healthChecks: { db: ok, redis: ok }, auth: ctx });
}

export async function login(ctx: AuthContext, loginId: string): Promise<string> {
  await addParamedic(ctx.pool, { loginId });
  const res = await request(appFor(ctx))
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  return res.body.tokens.accessToken;
}

async function addHospital(pool: pg.Pool, name: string, dLat: number): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO hospital (public_id, name, lat, lng, account_active) VALUES ($1, $1, $2, $3, true) RETURNING id`,
    [name, ORIGIN.lat + dLat, ORIGIN.lng],
  );
  const { rows: pc } = await pool.query<{ id: string }>(
    `INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, '접수대', $2) RETURNING id`,
    [rows[0].id, randomUUID()],
  );
  await pool.query(
    `INSERT INTO hospital_shift (pc_id, staff_name, alarm_on_at) VALUES ($1, '박서연', now())`,
    [pc[0].id],
  );
}

export interface Scene {
  kim: string;
  lee: string;
  transportId: string;
  // 병원 이름 → 병원 요청 id
  req: Record<string, number>;
}

export async function scene(ctx: AuthContext): Promise<Scene> {
  const kim = await login(ctx, 'kim01');
  const lee = await login(ctx, 'lee01');
  const team = await request(appFor(ctx))
    .post('/api/v1/teams')
    .set('Authorization', `Bearer ${kim}`)
    .send({ role: 'driver' });
  await request(appFor(ctx))
    .post('/api/v1/teams/join')
    .set('Authorization', `Bearer ${lee}`)
    .send({ code: team.body.code, role: 'care' });
  await addHospital(ctx.pool, 'B병원', 0.02);
  await addHospital(ctx.pool, 'C병원', 0.04);
  await addHospital(ctx.pool, 'D병원', 0.06);
  const created = await request(appFor(ctx))
    .post('/api/v1/transports')
    .set('Authorization', `Bearer ${kim}`)
    .send({
      id: randomUUID(),
      radiusKm: 20,
      location: ORIGIN,
      locationConsent: true,
      assessment: { chiefComplaint: '갑작스러운 두통' },
    });
  const req: Record<string, number> = {};
  for (const r of created.body.requests) req[r.hospitalName] = r.id;
  await ctx.pool.query(
    `UPDATE hospital_request SET status = 'approved', responded_at = now(), delivered_at = now()
      WHERE id = ANY($1::bigint[])`,
    [[req['B병원'], req['C병원']]],
  );
  return { kim, lee, transportId: created.body.id, req };
}

export async function requestStates(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT h.name, hr.status, hr.closed_reason FROM hospital_request hr
       JOIN hospital h ON h.id = hr.hospital_id ORDER BY h.name`,
  );
  return rows.map((r) => [r.name, r.status, r.closed_reason]);
}
