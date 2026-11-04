// 병원 웹 요청 목록·상세 테스트용: 병원 1곳 + 병원 웹 API (실시간 없이, REST 만)
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../app.js';
import { addHospitalWithKey, WEB_ORIGIN, withHospitalWeb } from './hospitalWeb.js';

export interface RequestHarness {
  pool: pg.Pool;
  hospitalId: string;
  registerPc: (pcName: string) => Promise<string>;
  get: (path: string, cookie: string) => request.Test;
  post: (path: string, cookie: string, body?: object) => request.Test;
}

export async function withRequestApp(use: (h: RequestHarness) => Promise<void>): Promise<void> {
  await withHospitalWeb(async (hospitalWeb) => {
    const app = createApp({
      logger: pino({ level: 'silent' }),
      healthChecks: { db: async () => 'ok', redis: async () => 'ok' },
      hospitalWeb,
    });
    const { hospitalId, key } = await addHospitalWithKey(hospitalWeb.pool);
    await use({
      pool: hospitalWeb.pool,
      hospitalId,
      registerPc: async (pcName) => {
        const res = await request(app)
          .post('/api/v1/hw/pc/register')
          .set('Origin', WEB_ORIGIN)
          .send({ licenseKey: key, pcName });
        const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
        const cookie = header.find((c) => c.startsWith('st_pc='));
        if (!cookie) throw new Error(`PC 등록 실패: ${res.status}`);
        return cookie.split(';')[0];
      },
      get: (path, cookie) =>
        request(app).get(`/api/v1${path}`).set('Origin', WEB_ORIGIN).set('Cookie', cookie),
      post: (path, cookie, body = {}) =>
        request(app)
          .post(`/api/v1${path}`)
          .set('Origin', WEB_ORIGIN)
          .set('Cookie', cookie)
          .send(body),
    });
  });
}
