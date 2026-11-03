// 병원 웹 실시간 연결 (/hospital 네임스페이스, 실시간 설계 2장·4-2)
// 방: hospital:{id} = 등록 PC 전체 · hospital:{id}:on = 알림 켠 PC 만 (요청 대상) · pc:{id} = 그 PC 의 탭들
import type pg from 'pg';
import type { Namespace, Server } from 'socket.io';
import { z } from 'zod';
import { AppError } from '../../http/errors.js';
import { findHospitalPc, type HospitalPc } from './pcAuth.js';

// shared/events.ts 의 HospitalServerEvents·HospitalClientEvents 중 지금 서버가 쓰는 것 (서버는 shared 를 못 불러온다)
export interface Envelope<T> {
  seq: number;
  room: string;
  occurredAt: string;
  serverNow: string;
  data: T;
}
export type AlarmOffReason = 'no_ack' | 'shift_ended';
export interface NewRequestData {
  requestId: number;
  label: string;
  respondUntil: string;
}
interface ServerEvents {
  'request.new': (e: Envelope<NewRequestData>, ack: (r: { received: true }) => void) => void;
  'hospital.alarm_off': (e: Envelope<{ reason: AlarmOffReason }>) => void;
}
interface ClientEvents {
  'alarm.resume': (req: unknown, ack: (r: { ok: boolean }) => void) => void;
}
interface SocketData {
  pc: HospitalPc;
}
export type HospitalNamespace = Namespace<ClientEvents, ServerEvents, object, SocketData>;

export const hospitalRoom = (hospitalId: number) => `hospital:${hospitalId}`;
export const alarmRoom = (hospitalId: number) => `hospital:${hospitalId}:on`;
export const pcRoom = (pcId: number) => `pc:${pcId}`;

const resumeSchema = z.object({ shiftId: z.number().int().positive() });

export function hospitalNamespace(
  io: Server,
  { pool, allowedOrigins }: { pool: pg.Pool; allowedOrigins: string[] },
): HospitalNamespace {
  const nsp: HospitalNamespace = io.of('/hospital');

  // 연결 입구: REST 와 똑같이 Origin → 등록 PC 쿠키 순서로 확인한다.
  // 실패하면 브라우저는 connect_error 로 오류 코드(PC_NOT_REGISTERED 등)를 받는다
  nsp.use(async (socket, next) => {
    try {
      const origin = socket.handshake.headers.origin;
      if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
        throw new AppError(403, 'ORIGIN_NOT_ALLOWED', '허용되지 않은 주소에서 온 연결이에요');
      }
      socket.data.pc = await findHospitalPc(pool, socket.handshake.headers.cookie);
      next();
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'INTERNAL';
      next(Object.assign(new Error(code), { data: { code } }));
    }
  });

  nsp.on('connection', (socket) => {
    const { pc } = socket.data;
    void socket.join([hospitalRoom(pc.hospitalId), pcRoom(pc.pcId)]);

    // 탭을 연 채로 연결만 끊겼다 붙었을 때: 웹이 기억한 shiftId 로 알림 켜기를 되살린다.
    // 같은 PC 의 아직 안 끝난 근무이고, 알림을 켰던 근무일 때만 허락한다 (새로고침한 탭은 shiftId 가 없다)
    socket.on('alarm.resume', async (req, ack) => {
      if (typeof ack !== 'function') return;
      const parsed = resumeSchema.safeParse(req);
      if (!parsed.success) return ack({ ok: false });
      try {
        const { rowCount } = await pool.query(
          `SELECT 1 FROM hospital_shift
            WHERE id = $1 AND pc_id = $2 AND ended_at IS NULL AND alarm_on_at IS NOT NULL`,
          [parsed.data.shiftId, pc.pcId],
        );
        if (rowCount === 0) return ack({ ok: false });
        await socket.join(alarmRoom(pc.hospitalId));
        ack({ ok: true });
      } catch {
        ack({ ok: false });
      }
    });
  });

  return nsp;
}

// 알림 켜기: 이 PC 의 그 탭(socketId)만 요청 대상 방에 넣는다.
// 다른 PC 의 연결 id 를 보내 남의 탭을 넣는 일은 막는다. 서버가 2대여도 Redis 어댑터로 찾는다
export async function joinAlarmRoom(
  nsp: HospitalNamespace,
  pc: HospitalPc,
  socketId: string,
): Promise<boolean> {
  const sockets = await nsp.in(socketId).fetchSockets();
  const mine = sockets.find((s) => s.id === socketId && s.data.pc?.pcId === pc.pcId);
  if (!mine) return false;
  mine.join(alarmRoom(pc.hospitalId));
  return true;
}

// 병원 웹 이벤트 머리. 병원 웹은 놓친 이벤트를 다시 받지 않고 항상 전체를 새로 받으므로
// seq 를 쓰지 않는다 (실시간 설계 3장)
export function envelope<T>(room: string, now: Date, data: T): Envelope<T> {
  return { seq: 0, room, occurredAt: now.toISOString(), serverNow: now.toISOString(), data };
}

// 탭들(room 은 pc:{id} 또는 연결 id 들)을 요청 대상에서 빼고 이유를 알려 준다 (근무 종료·응답 없음)
export function turnAlarmOff(
  nsp: HospitalNamespace,
  { hospitalId, tabs }: { hospitalId: number; tabs: string | string[] },
  reason: AlarmOffReason,
  now: Date,
): void {
  nsp.in(tabs).socketsLeave(alarmRoom(hospitalId));
  const room = Array.isArray(tabs) ? alarmRoom(hospitalId) : tabs;
  nsp.to(tabs).emit('hospital.alarm_off', envelope(room, now, { reason }));
}
