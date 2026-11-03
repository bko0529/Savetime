// 병원 웹 실시간 테스트용: 실제 http 서버 + Socket.IO + 임시 DB + 실제 Redis 에 PC·탭을 붙인다
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { pino } from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createApp } from '../app.js';
import type { HospitalWebContext } from '../modules/hospital-web/pcAuth.js';
import { alarmRoom } from '../modules/hospital-web/realtime.js';
import { addHospitalWithKey, WEB_ORIGIN, withHospitalWeb } from './hospitalWeb.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

export interface Harness {
  pool: pg.Pool;
  ctx: HospitalWebContext;
  http: HttpServer;
  hospitalId: number;
  // 같은 병원에 PC 를 하나 등록하고 그 쿠키를 돌려준다
  registerPc: (name: string) => Promise<string>;
  post: (path: string, cookie: string, body?: object) => request.Test;
  session: (cookie: string) => request.Test;
  get: (path: string, cookie: string) => request.Test;
  // 브라우저 탭 하나처럼 /hospital 에 붙는다
  openTab: (cookie?: string, origin?: string) => Socket;
}

export async function withLiveHospitalWeb(use: (h: Harness) => Promise<void>): Promise<void> {
  await withHospitalWeb(async (ctx, realtime) => {
    const app = createApp({ logger, healthChecks: { db: ok, redis: ok }, hospitalWeb: ctx });
    const http = createServer(app);
    realtime.io.attach(http);
    http.listen(0);
    await once(http, 'listening');
    const url = `http://localhost:${(http.address() as AddressInfo).port}`;
    const tabs: Socket[] = [];

    const { hospitalId, key } = await addHospitalWithKey(ctx.pool);
    try {
      await use({
        pool: ctx.pool,
        ctx,
        http,
        hospitalId: Number(hospitalId),
        registerPc: async (pcName) => {
          const res = await request(http)
            .post('/api/v1/hw/pc/register')
            .set('Origin', WEB_ORIGIN)
            .send({ licenseKey: key, pcName });
          assert.equal(res.status, 201);
          const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
          return header.find((c) => c.startsWith('st_pc='))!.split(';')[0];
        },
        post: (path, cookie, body = {}) =>
          request(http)
            .post(`/api/v1${path}`)
            .set('Origin', WEB_ORIGIN)
            .set('Cookie', cookie)
            .send(body),
        session: (cookie) =>
          request(http).get('/api/v1/hw/session').set('Origin', WEB_ORIGIN).set('Cookie', cookie),
        get: (path, cookie) =>
          request(http).get(`/api/v1${path}`).set('Origin', WEB_ORIGIN).set('Cookie', cookie),
        openTab: (cookie, origin = WEB_ORIGIN) => {
          const socket = connect(`${url}/hospital`, {
            transports: ['websocket'],
            reconnection: false,
            extraHeaders: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
          });
          tabs.push(socket);
          return socket;
        },
      });
    } finally {
      // 실시간 서버는 withHospitalWeb 이 닫는다
      for (const tab of tabs) tab.disconnect();
      http.close();
    }
  });
}

// 소켓에 이벤트가 한 번 올 때까지 기다린다 (2초 넘으면 실패)
export function nextEvent<T = unknown>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} 이벤트가 오지 않았어요`)), 2000);
    socket.once(name, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export async function connected(socket: Socket): Promise<string> {
  if (!socket.connected) await nextEvent(socket, 'connect');
  return socket.id!;
}

export async function connectError(socket: Socket): Promise<string> {
  return (await nextEvent<Error>(socket, 'connect_error')).message;
}

export interface AlarmOff {
  room: string;
  data: { reason: string };
}

// 지금 요청 대상 방(hospital:{id}:on)에 들어 있는 연결 id 들
export async function alarmMembers(h: Harness): Promise<string[]> {
  const sockets = await h.ctx.hospitalIo.in(alarmRoom(h.hospitalId)).fetchSockets();
  return sockets.map((s) => s.id).sort();
}

export function resume(socket: Socket, shiftId: unknown): Promise<{ ok: boolean }> {
  return socket.timeout(2000).emitWithAck('alarm.resume', { shiftId });
}
