// 실시간 서버 (Socket.IO 4, 실시간 통신 설계 2~4장).
// - /app: 구급대원 앱. 접근 토큰으로 확인하고 paramedic:{id}·team:{teamId} 방에 넣는다. sync로 놓친 이벤트를 다시 받는다.
// - /hospital: 병원 웹. 등록 PC 쿠키(st_pc)로 PC를 알아보고 hospital:{id} 방에, 알림을 켠 PC는 hospital:{id}:on 방에 넣는다.
// - 서버 2대 대비: 방 정보는 Redis 어댑터로 서버끼리 나눠 보고, 5초 판정 같은 타이머는 BullMQ 예약 작업으로 돌린다.
//   서버 메모리에 상태를 두지 않는다 (절대 규칙 7). 알림 켜짐 여부의 기준도 DB(hospital_shift.alarm_on_at)다.
import { createHash } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { Server, type DefaultEventsMap, type Namespace, type RemoteSocket } from 'socket.io';
import { withTransaction } from '../../db/transaction.js';
import {
  transitionHreq,
  transitionTransport,
  transportEventAfterHreqChange,
  type HreqStatus,
  type TransportStatus,
} from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { authenticateParamedic } from '../auth/guards.js';
import type { AuthContext } from '../auth/session.js';
import { currentTeamId } from '../team/routes.js';
import {
  appendEvents,
  EVENT_COLUMNS,
  fromRow,
  toEnvelope,
  type EventRecord,
  type LoggedEvent,
} from './eventLog.js';

// REST 쪽(라우터)이 부르는 기능. 실시간 서버가 없는 테스트·관리자 서버에서는 넘기지 않는다
export interface Realtime {
  // 트랜잭션이 커밋된 뒤에만 부른다. 롤백된 이벤트는 절대 나가지 않는다
  publish(events: LoggedEvent[]): void;
  // 새 회차의 병원 요청을 알림 켠 PC에 보내고 5초 '받았음'을 센다 (SFR-161). 응답을 기다리지 않는다
  deliverRound(roundId: string): void;
  joinTeam(paramedicId: string, teamId: string): Promise<void>;
  // 근무 종료·로그아웃·탈퇴: 그 대원의 연결을 모두 끊는다 (SER-016)
  disconnectParamedic(paramedicId: string): Promise<void>;
  // 병원 웹 '알림 켜기'(REST): 이 PC 의 그 탭만 hospital:{id}:on 방에 넣는다 (SFR-117).
  // 다른 PC 의 연결 id 면 넣지 않고 false. 다른 서버에 붙은 탭도 Redis 어댑터로 찾는다
  alarmOn(pc: { pcId: string; hospitalId: string }, socketId: string): Promise<boolean>;
  // 근무 종료 등: 이 PC 의 탭들을 :on 방에서 빼고 hospital.alarm_off 를 보낸다
  alarmOff(pc: { pcId: string; hospitalId: string }, reason: 'shift_ended'): Promise<void>;
  attach(httpServer: HttpServer): void;
  close(): Promise<void>;
}

export interface RealtimeOptions {
  auth: AuthContext;
  redisUrl: string;
  logger: Logger;
  // 테스트는 짧게 줄인다. 운영은 5초 (SFR-161)
  deliveryTimeoutMs?: number;
  // 테스트 파일끼리 Redis 채널·큐가 섞이지 않게 이름 앞에 붙인다
  prefix?: string;
}

interface AppSocketData {
  paramedicId: string;
  teamId?: string;
}
interface HospitalSocketData {
  pcId: string;
  hospitalId: string;
  shiftId?: string;
}

const DELIVERY_QUEUE = 'delivery-check';
const REPLAY_LIMIT = 500;
// 병원 웹은 다시 받기를 하지 않고 재연결 때 목록을 새로 받으므로(설계 3장) 직접 보내는 이벤트에는 seq를 쓰지 않는다
const NO_SEQ = 0;

const onRoom = (hospitalId: string) => `hospital:${hospitalId}:on`;

function directEnvelope<T>(room: string, data: T, entityVersion?: number) {
  const now = new Date().toISOString();
  return {
    seq: NO_SEQ,
    room,
    occurredAt: now,
    serverNow: now,
    ...(entityVersion === undefined ? {} : { entityVersion }),
    data,
  };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

// PC 쿠키는 추측할 수 없는 무작위 값이라 빠른 해시로 충분하다. PC 등록 API도 같은 방식으로 저장해야 한다 (COR-012)
export function hashPcToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createRealtime(options: RealtimeOptions): Realtime {
  const { auth, logger } = options;
  const { pool } = auth;
  const timeoutMs = options.deliveryTimeoutMs ?? 5000;
  const prefix = options.prefix ?? 'savetime';

  // INR-003: ping 5초, 응답 대기 5초 → 끊김을 10초 안에 안다. 처음부터 웹소켓만 써서 서버 고정이 필요 없다 (T-08)
  const io = new Server({ transports: ['websocket'], pingInterval: 5000, pingTimeout: 5000 });
  const pub = new Redis(options.redisUrl);
  const sub = pub.duplicate();
  for (const client of [pub, sub]) {
    client.on('error', (err) => logger.error({ message: err.message }, '실시간 Redis 오류'));
  }
  io.adapter(createAdapter(pub, sub, { key: `${prefix}#socket.io` }));

  const app: Namespace = io.of('/app');
  const hospital: Namespace = io.of('/hospital');

  // ---------- /app ----------
  app.use(async (socket, next) => {
    try {
      const { paramedicId } = await authenticateParamedic(auth, socket.handshake.auth?.token);
      // DB는 여기서 미리 본다. 연결 처리기 안에서 기다리면 그사이 앱이 보낸 sync를 놓친다
      const teamId = await currentTeamId(pool, paramedicId);
      Object.assign(socket.data as AppSocketData, { paramedicId, teamId });
      next();
    } catch (err) {
      // 앱은 message로 이유를 안다: TOKEN_EXPIRED면 갱신 후 다시 연결 (설계 2장)
      next(new Error(err instanceof AppError ? err.code : 'TOKEN_REVOKED'));
    }
  });

  // 처리기는 기다림 없이 바로 등록한다 (연결 직후 오는 sync·alarm.resume을 놓치지 않게)
  app.on('connection', (socket) => {
    const { paramedicId, teamId } = socket.data as AppSocketData;
    void socket.join(`paramedic:${paramedicId}`);
    if (teamId) void socket.join(`team:${teamId}`);

    // 연결·재연결 직후 앱이 1번 부른다. 놓친 이벤트를 순서대로 보내고 ack (설계 3장)
    socket.on('sync', async (req: { lastSeq?: unknown }, ack: unknown) => {
      if (typeof ack !== 'function') return;
      try {
        ack(
          await replay(paramedicId, typeof req?.lastSeq === 'number' ? req.lastSeq : null, socket),
        );
      } catch (err) {
        logger.error({ message: (err as Error).message }, '다시 보내기 실패');
        ack({
          replayed: 0,
          snapshotRequired: true,
          latestSeq: 0,
          serverNow: new Date().toISOString(),
        });
      }
    });
  });

  async function replay(
    paramedicId: string,
    lastSeq: number | null,
    socket: { emit: (name: string, payload: unknown) => boolean },
  ) {
    const { rows: bounds } = await pool.query<{ oldest: string | null; latest: string | null }>(
      'SELECT min(seq) AS oldest, max(seq) AS latest FROM event_log',
    );
    const latestSeq = Number(bounds[0].latest ?? 0);
    const serverNow = new Date().toISOString();
    // 처음 연결이거나, 그사이 24시간 지난 이벤트가 지워져 빈틈이 생겼으면 전체를 REST로 다시 받게 한다
    const oldest = bounds[0].oldest === null ? null : Number(bounds[0].oldest);
    if (lastSeq === null || (oldest !== null && lastSeq < oldest - 1)) {
      return { replayed: 0, snapshotRequired: true, latestSeq, serverNow };
    }

    const { rows: member } = await pool.query<{ team_id: string; joined_seq: string | null }>(
      'SELECT team_id, joined_seq FROM team_member WHERE paramedic_id = $1 AND left_at IS NULL',
      [paramedicId],
    );
    // 팀 이벤트는 팀에 들어온 뒤의 것만 (joined_seq). 들어오기 전 환자 정보 흐름은 보내지 않는다
    const teamRoom = member[0] ? `team:${member[0].team_id}` : null;
    const teamFrom = Math.max(lastSeq, Number(member[0]?.joined_seq ?? 0));
    const { rows } = await pool.query(
      `SELECT ${EVENT_COLUMNS} FROM event_log
        WHERE (room = $1 AND seq > $2) OR (room = $3 AND seq > $4)
        ORDER BY seq LIMIT ${REPLAY_LIMIT}`,
      [`paramedic:${paramedicId}`, lastSeq, teamRoom, teamFrom],
    );
    for (const row of rows) {
      const event = fromRow(row);
      socket.emit(event.name, toEnvelope(event));
    }
    // 한 번에 다 못 보냈으면 나머지는 REST로
    return {
      replayed: rows.length,
      snapshotRequired: rows.length === REPLAY_LIMIT,
      latestSeq,
      serverNow,
    };
  }

  // ---------- /hospital ----------
  hospital.use(async (socket, next) => {
    try {
      const token = readCookie(socket.handshake.headers.cookie, 'st_pc');
      const { rows } = token
        ? await pool.query<{ id: string; hospital_id: string }>(
            `SELECT p.id, p.hospital_id
               FROM hospital_pc p JOIN hospital h ON h.id = p.hospital_id
              WHERE p.token_hash = $1 AND p.released_at IS NULL AND h.account_active`,
            [hashPcToken(token)],
          )
        : { rows: [] };
      if (!rows[0]) {
        next(new Error('PC_NOT_REGISTERED'));
        return;
      }
      Object.assign(socket.data as HospitalSocketData, {
        pcId: rows[0].id,
        hospitalId: rows[0].hospital_id,
      });
      next();
    } catch {
      next(new Error('PC_NOT_REGISTERED'));
    }
  });

  hospital.on('connection', (socket) => {
    const data = socket.data as HospitalSocketData;
    void socket.join(`hospital:${data.hospitalId}`);

    // 탭을 유지한 채 다시 붙으면 같은 PC·같은 근무인지 확인하고 알림 켜기를 되살린다 (SFR-117, 설계 2장)
    socket.on('alarm.resume', async (req: { shiftId?: unknown }, ack: unknown) => {
      if (typeof ack !== 'function') return;
      const shiftId = typeof req?.shiftId === 'number' ? String(req.shiftId) : null;
      const { rows } = shiftId
        ? await pool.query(
            `UPDATE hospital_shift SET alarm_on_at = now()
              WHERE id = $1 AND pc_id = $2 AND ended_at IS NULL RETURNING id`,
            [shiftId, data.pcId],
          )
        : { rows: [] };
      if (!rows[0]) {
        ack({ ok: false });
        return;
      }
      data.shiftId = shiftId!;
      await socket.join(onRoom(data.hospitalId));
      ack({ ok: true });
    });

    // REST(알림 켜기)로 방에 들어간 탭은 shiftId 를 모른다(다른 서버가 넣었을 수도 있다).
    // 그래서 끊기기 직전 아직 :on 방에 있었으면 이 PC 의 진행 중 근무로 알림을 푼다
    socket.on('disconnecting', () => {
      if (data.shiftId || !socket.rooms.has(onRoom(data.hospitalId))) return;
      pool
        .query(
          'UPDATE hospital_shift SET alarm_on_at = NULL WHERE pc_id = $1 AND ended_at IS NULL',
          [data.pcId],
        )
        .catch((err: Error) => logger.error({ message: err.message }, '알림 끄기 실패'));
    });

    // 브라우저를 닫거나 연결이 끊기면 '요청 받을 수 있음'을 푼다 (SFR-117). 요청 대상 판정은 DB 값을 본다
    socket.on('disconnect', () => {
      if (!data.shiftId) return;
      pool
        .query('UPDATE hospital_shift SET alarm_on_at = NULL WHERE id = $1 AND ended_at IS NULL', [
          data.shiftId,
        ])
        .catch((err: Error) => logger.error({ message: err.message }, '알림 끄기 실패'));
    });
  });

  // ---------- 보내기 ----------
  function publish(events: LoggedEvent[]): void {
    for (const event of events) {
      const ns = event.room.startsWith('hospital:') ? hospital : app;
      ns.to(event.room).emit(event.name, toEnvelope(event));
    }
  }

  // ---------- 요청 전달 확인 (SFR-161) ----------
  const connection = { url: options.redisUrl };
  const queue = new Queue(DELIVERY_QUEUE, { connection, prefix });
  const worker = new Worker(
    DELIVERY_QUEUE,
    async (job) => {
      const logged = await finalizeDelivery(String(job.data.roundId));
      if (logged) publish(logged);
    },
    { connection, prefix, concurrency: 10, autorun: false },
  );
  queue.on('error', (err) => logger.error({ message: err.message }, '전달 확인 큐 오류'));
  worker.on('error', (err) => logger.error({ message: err.message }, '전달 확인 워커 오류'));
  worker.on('failed', (_job, err) => logger.error({ message: err.message }, '전달 확인 실패'));
  void worker.run().catch((err: Error) => logger.error({ message: err.message }, '워커 시작 실패'));

  // 서버가 재시작되면 Redis의 예약 작업이 사라졌을 수 있다. 판정이 안 끝난 최근 회차를 DB에서 찾아 다시 건다 (기술정의서 타이머)
  // 같은 jobId라 이미 걸려 있으면 다시 만들지 않는다
  void pool
    .query<{ id: string }>(
      `SELECT DISTINCT r.id FROM request_round r JOIN hospital_request hr ON hr.round_id = r.id
        WHERE hr.status = 'waiting' AND hr.delivered_at IS NULL
          AND r.sent_at > now() - interval '2 minutes'`,
    )
    .then(({ rows }) => Promise.all(rows.map((row) => scheduleCheck(row.id, 0))))
    .catch((err: Error) => logger.error({ message: err.message }, '전달 확인 다시 걸기 실패'));

  // 1대라도 ack하면 그 병원에 '전달'. ack 안 한 PC는 :on에서 빼고 알림을 끈다 (설계 4-2 전달 판정)
  async function sendToPc(
    socket: RemoteSocket<DefaultEventsMap, HospitalSocketData>,
    request: { id: string; hospitalId: string; respondUntil: Date },
  ): Promise<void> {
    const room = onRoom(request.hospitalId);
    try {
      await hospital
        .to(socket.id)
        .timeout(timeoutMs)
        .emitWithAck(
          'request.new',
          directEnvelope(
            room,
            {
              requestId: Number(request.id),
              label: '새 이송 요청',
              respondUntil: request.respondUntil.toISOString(),
            },
            1,
          ),
        );
      // 5초가 지난 뒤 늦게 온 '받았음'은 세지 않는다. 판정은 DB 시각으로 (절대 규칙 6)
      await pool.query(
        `UPDATE hospital_request hr SET delivered_at = now()
           FROM request_round r
          WHERE hr.id = $1 AND r.id = hr.round_id AND hr.status = 'waiting'
            AND hr.delivered_at IS NULL AND now() < r.sent_at + make_interval(secs => $2)`,
        [request.id, timeoutMs / 1000],
      );
    } catch {
      socket.leave(room);
      socket.emit('hospital.alarm_off', directEnvelope(room, { reason: 'no_ack' }));
      if (socket.data.shiftId) {
        await pool.query('UPDATE hospital_shift SET alarm_on_at = NULL WHERE id = $1', [
          socket.data.shiftId,
        ]);
      }
    }
  }

  async function scheduleCheck(roundId: string, delay: number): Promise<void> {
    await queue.add(
      'check',
      { roundId },
      {
        jobId: `delivery-${roundId}`,
        delay,
        // 일찍 깨어나 '아직 시간이 안 됐어요'로 실패하면 조금 뒤 다시 한다
        attempts: 5,
        backoff: { type: 'fixed', delay: 500 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }

  async function deliver(roundId: string): Promise<void> {
    // 먼저 5초 판정 작업을 걸어 둔다. 이 서버가 보내다 죽어도 판정은 다른 서버가 한다
    await scheduleCheck(roundId, timeoutMs + 300);
    const { rows } = await pool.query<{ id: string; hospital_id: string; respond_until: Date }>(
      `SELECT hr.id, hr.hospital_id, r.respond_until
         FROM hospital_request hr JOIN request_round r ON r.id = hr.round_id
        WHERE hr.round_id = $1 AND hr.status = 'waiting' ORDER BY hr.id`,
      [roundId],
    );
    await Promise.all(
      rows.map(async (row) => {
        const sockets = await hospital.in(onRoom(row.hospital_id)).fetchSockets();
        const request = {
          id: row.id,
          hospitalId: row.hospital_id,
          respondUntil: row.respond_until,
        };
        await Promise.all(
          sockets.map((s) =>
            sendToPc(s as RemoteSocket<DefaultEventsMap, HospitalSocketData>, request),
          ),
        );
      }),
    );
  }

  // 5초가 지나면: '받았음'이 없는 병원 요청을 전달 실패로 닫고, 전달된 곳이 0곳이면 예비 추천으로 (부록 A-2 35, A8)
  async function finalizeDelivery(roundId: string): Promise<LoggedEvent[] | null> {
    return withTransaction(pool, async (client) => {
      const { rows: clock } = await client.query<{ now: Date }>('SELECT now()');
      const now = clock[0].now;
      const { rows: rounds } = await client.query<{
        transport_id: string;
        round_no: number;
        approval_valid_until: Date;
        due: boolean;
        is_current: boolean;
      }>(
        `SELECT r.transport_id, r.round_no, r.approval_valid_until,
                now() >= r.sent_at + make_interval(secs => $2) AS due,
                r.round_no = (SELECT max(round_no) FROM request_round WHERE transport_id = r.transport_id) AS is_current
           FROM request_round r WHERE r.id = $1`,
        [roundId, timeoutMs / 1000],
      );
      const round = rounds[0];
      if (!round) return null;
      // 예약 작업이 조금 일찍 깨어나도 DB 시각으로 다시 본다
      if (!round.due) throw new Error('아직 전달 확인 시간이 안 됐어요');

      // 잠금 순서: 이송 건 먼저, 그다음 병원 요청 id 오름차순 (stateMachine.ts 규칙 5)
      const { rows: transports } = await client.query<{
        status: TransportStatus;
        version: number;
        team_id: string | null;
      }>('SELECT status, version, team_id FROM transport WHERE id = $1 FOR UPDATE', [
        round.transport_id,
      ]);
      const transport = transports[0];
      const { rows: requests } = await client.query<{
        id: string;
        hospital_id: string;
        status: HreqStatus;
        version: number;
        delivered_at: Date | null;
      }>(
        `SELECT id, hospital_id, status, version, delivered_at FROM hospital_request
          WHERE round_id = $1 ORDER BY id FOR UPDATE`,
        [roundId],
      );

      const failedHospitalIds: number[] = [];
      for (const request of requests) {
        if (request.status !== 'waiting' || request.delivered_at !== null) continue;
        const result = transitionHreq(request.status, 'NO_ACK_5S', {
          now,
          version: request.version,
        });
        await client.query(
          `UPDATE hospital_request SET status = $2, version = version + 1, updated_at = now()
            WHERE id = $1`,
          [request.id, result.to],
        );
        request.status = result.to;
        failedHospitalIds.push(Number(request.hospital_id));
      }

      const room = `team:${transport.team_id}`;
      const events: EventRecord[] = [
        {
          room,
          name: 'request.delivered',
          entityType: 'transport',
          entityId: round.transport_id,
          entityVersion: transport.version,
          payload: {
            transportId: round.transport_id,
            roundNo: round.round_no,
            deliveredCount: requests.filter((r) => r.delivered_at !== null).length,
            failedHospitalIds,
            final: true,
          },
        },
      ];

      // 역방향 연쇄: 지금 회차에 대기·유효 승인이 하나도 없으면 이송 건을 예비 추천으로 (SFR-112·161)
      if (failedHospitalIds.length > 0 && round.is_current) {
        const counts = {
          waiting: requests.filter((r) => r.status === 'waiting').length,
          validApproved: requests.filter(
            (r) => r.status === 'approved' && now < round.approval_valid_until,
          ).length,
        };
        const next = transportEventAfterHreqChange(
          transport.status,
          { event: 'NO_ACK_5S', fromStatus: 'waiting' },
          counts,
        );
        if (next) {
          const { to, history } = transitionTransport(transport.status, next.event, {
            now,
            version: transport.version,
            fallbackReason: next.reason,
          });
          const { rows: updated } = await client.query<{ version: number }>(
            `UPDATE transport
                SET status = $2, version = version + 1,
                    fallback_reason = CASE WHEN $2::transport_status = 'fallback' THEN $3 ELSE fallback_reason END
              WHERE id = $1 RETURNING version`,
            [round.transport_id, to, history.reason],
          );
          await client.query(
            `INSERT INTO transport_status_history (transport_id, from_status, to_status, event, reason, at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              round.transport_id,
              history.from,
              history.to,
              history.event,
              history.reason,
              history.at,
            ],
          );
          events.push({
            room,
            name: 'transport.status',
            entityType: 'transport',
            entityId: round.transport_id,
            entityVersion: updated[0].version,
            payload: {
              transportId: round.transport_id,
              status: to,
              event: history.event,
              reason: history.reason,
              byName: null,
            },
          });
        }
      }
      return appendEvents(client, events);
    });
  }

  return {
    publish,
    deliverRound(roundId) {
      deliver(roundId).catch((err: Error) =>
        logger.error({ message: err.message, roundId }, '요청 전달 실패'),
      );
    },
    async joinTeam(paramedicId, teamId) {
      app.in(`paramedic:${paramedicId}`).socketsJoin(`team:${teamId}`);
    },
    async disconnectParamedic(paramedicId) {
      app.in(`paramedic:${paramedicId}`).disconnectSockets(true);
    },
    async alarmOn(pc, socketId) {
      const [socket] = await hospital.in(socketId).fetchSockets();
      if (!socket || (socket.data as HospitalSocketData).pcId !== pc.pcId) return false;
      socket.join(onRoom(pc.hospitalId));
      return true;
    },
    async alarmOff(pc, reason) {
      const room = onRoom(pc.hospitalId);
      const sockets = await hospital.in(`hospital:${pc.hospitalId}`).fetchSockets();
      for (const socket of sockets) {
        if ((socket.data as HospitalSocketData).pcId !== pc.pcId) continue;
        socket.leave(room);
        socket.emit('hospital.alarm_off', directEnvelope(room, { reason }));
      }
    },
    attach(httpServer) {
      io.attach(httpServer);
    },
    // 이 서버에 붙은 연결만 끊는다. 앱·병원 웹은 다른 서버로 다시 붙는다 (서버 1대씩 교체 배포, COR-016)
    // HTTP 서버는 부르는 쪽이 닫는다. 연결이 남아 있으면 HTTP 서버가 닫히지 않으므로 이걸 먼저 부른다
    async close() {
      io.local.disconnectSockets(true);
      await worker.close();
      await queue.close();
      pub.disconnect();
      sub.disconnect();
    },
  };
}
