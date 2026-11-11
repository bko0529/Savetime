// Artillery 시나리오가 부르는 함수 (부하 테스트 연습, PER-005).
// 가상 사용자 1명 = 병원 PC 1대. 사용자마다 .pcs.csv 의 다른 쿠키로 /hospital 실시간 연결을 맺고 유지한다.
// Artillery 내장 Socket.IO 엔진은 사용자마다 다른 쿠키 헤더를 붙이기 어려워서, 프로젝트의 socket.io-client 로 직접 붙는다.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';

// fetch 는 Node 18+ 에 들어 있지만 import 할 모듈이 없어 globalThis 에서 꺼낸다 (perf/ 는 lint 에 Node 전역이 없다)
const { fetch } = globalThis;

// 저장소 루트의 node_modules 에서 찾는다 (서버가 쓰는 것과 같은 4.x)
const require = createRequire(new URL('../package.json', import.meta.url));
const { io } = require('socket.io-client');

const WEB_ORIGIN = process.env.PERF_ORIGIN ?? 'http://localhost:3000';

// ---- 가상 사용자마다 다른 줄 나눠 주기 ----
// Artillery 는 가상 사용자를 작업자(CPU 수 − 1개) 여러 개에 나눠 돌리는데, config.payload 의 order: sequence 는
// 작업자마다 파일 첫 줄부터 다시 읽는다. 그러면 같은 대원·PC 가 여러 번 쓰여 '대원 300명'이 실제로는 60명이 된다.
// 그래서 줄마다 '찜' 폴더를 만든다. 폴더 만들기는 여러 작업자가 동시에 해도 한 곳만 성공하므로 한 줄은 한 명만 쓴다.
const CLAIMS = fileURLToPath(new URL('./results/claims/', import.meta.url));
const rowsCache = new Map();
const cursors = new Map();

// 찜 기록을 지우는 기준. 시나리오 하나가 이보다 오래 돌지 않는다
const CLAIM_KEEP_MS = 6 * 60 * 60 * 1000;

// before 단계(작업자를 나누기 전 1번): 이번 실행의 번호를 정하고 오래된 실행의 찜 기록만 지운다.
// 전부 지우면 동시에 돌고 있는 다른 시나리오(run-s8.sh 는 연결 시나리오 둘과 이송을 함께 돌린다)의 찜이 사라져 같은 줄을 두 번 쓴다
export function newRun(context, _events, done) {
  const runId = Date.now();
  mkdirSync(CLAIMS, { recursive: true });
  for (const dir of readdirSync(CLAIMS)) {
    // 폴더 이름 = '시작 시각-프로세스 번호'. 시작 시각이 6시간 넘게 지난 것만 지운다
    if (runId - Number.parseInt(dir, 10) > CLAIM_KEEP_MS) {
      // 동시에 시작한 다른 실행이 같은 폴더를 지우는 중이면 실패할 수 있다(Windows EPERM). 지우기는 정리일 뿐이라 넘어간다
      try {
        rmSync(`${CLAIMS}${dir}`, { recursive: true, force: true });
      } catch {
        // 다음 실행이 다시 지운다
      }
    }
  }
  // 같은 밀리초에 두 실행이 시작돼도 겹치지 않게 프로세스 번호를 붙인다
  context.vars.runId = `${runId}-${process.pid}`;
  done();
}

function claimRow(context, events, file) {
  if (!rowsCache.has(file)) {
    const lines = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      .trim()
      .split(/\r?\n/);
    const header = lines[0].split(',');
    rowsCache.set(
      file,
      lines
        .slice(1)
        .map((line) => Object.fromEntries(line.split(',').map((v, i) => [header[i], v]))),
    );
  }
  const rows = rowsCache.get(file);
  // 작업자마다 커서는 앞으로만 간다. 다른 작업자가 찜한 줄은 한 번만 건너뛴다
  for (let i = cursors.get(file) ?? 0; i < rows.length; i += 1) {
    try {
      mkdirSync(`${CLAIMS}${context.vars.runId}/${file}/${i}`, { recursive: false });
    } catch (err) {
      if (err.code === 'ENOENT') {
        mkdirSync(`${CLAIMS}${context.vars.runId}/${file}`, { recursive: true });
        i -= 1;
      }
      continue;
    }
    cursors.set(file, i + 1);
    Object.assign(context.vars, rows[i]);
    return true;
  }
  cursors.set(file, rows.length);
  // 준비한 줄보다 가상 사용자가 많다 → 준비 스크립트의 수를 늘린다
  events.emit('counter', `payload.exhausted.${file}`, 1);
  return false;
}

// 시나리오 beforeScenario 에서 부른다. 줄이 모자라면 그 가상 사용자는 실패로 끝난다
export function pickPc(context, events, next) {
  next(claimRow(context, events, '.pcs.csv') ? undefined : new Error('PAYLOAD_EXHAUSTED'));
}
export function pickMedic(context, events, next) {
  next(claimRow(context, events, '.medics.csv') ? undefined : new Error('PAYLOAD_EXHAUSTED'));
}
export function pickMoving(context, events, next) {
  next(claimRow(context, events, '.moving.csv') ? undefined : new Error('PAYLOAD_EXHAUSTED'));
}

// 연결을 맺고 걸린 시간을 기록한다. 실패해도 시나리오는 이어 가고 실패 수만 센다
export function connectHospital(context, events, done) {
  const started = Date.now();
  const socket = io(`${context.vars.target}/hospital`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    extraHeaders: { Cookie: context.vars.cookie, Origin: WEB_ORIGIN },
  });
  context.vars.socket = socket;

  socket.once('connect', () => {
    events.emit('histogram', 'hospital.connect_ms', Date.now() - started);
    events.emit('counter', 'hospital.connected', 1);
    done();
  });
  socket.once('connect_error', (err) => {
    // 서버가 거절한 이유(PC_NOT_REGISTERED 등)별로 센다
    events.emit('counter', `hospital.connect_error.${err.message}`, 1);
    done();
  });
  // 유지하는 동안 서버가 끊으면 따로 센다 (연결 유지 실패)
  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') events.emit('counter', `hospital.dropped.${reason}`, 1);
  });
}

export function disconnectHospital(context, _events, done) {
  context.vars.socket?.disconnect();
  done();
}

// ---- 대원 앱 (PER-005 대원 앱 쪽) ----
// 가상 사용자 1명 = 대원 앱 1대. .medics.csv 의 접근 토큰으로 /app 실시간 연결을 맺고 유지한다
export function connectParamedic(context, events, done) {
  const started = Date.now();
  const socket = io(`${context.vars.target}/app`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    auth: { token: context.vars.token },
  });
  context.vars.socket = socket;

  socket.once('connect', () => {
    events.emit('histogram', 'app.connect_ms', Date.now() - started);
    events.emit('counter', 'app.connected', 1);
    done();
  });
  socket.once('connect_error', (err) => {
    // TOKEN_EXPIRED 가 많으면 perf:medics 를 다시 돌린다 (토큰 15분)
    events.emit('counter', `app.connect_error.${err.message}`, 1);
    done();
  });
  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') events.emit('counter', `app.dropped.${reason}`, 1);
  });
}

export function disconnectParamedic(context, _events, done) {
  context.vars.socket?.disconnect();
  done();
}

// ---- 이송 한 건 처음부터 끝까지 (PER-007 동시 이송, PER-006 병원 응답 → 대원 앱) ----
// 가상 사용자 1명 = 대원 1명(팀 1개). hospital-bot.mjs 가 병원 역할로 요청을 받아 승인한다.
//   /app 연결 → 이송 만들기(병원에 동시 요청) → 첫 승인 알림 기다리기 → 확정 → 이동 중으로 holdSeconds 유지 → 도착
// 보는 값
//   transport.create_ms / confirm_ms / arrive_ms : 각 API 응답 시간
//   transport.approved_notify_ms : 병원이 승인한 DB 시각(occurredAt) → 대원 앱이 받은 시각 (PER-006 뒤쪽 절반)
//   transport.moving : 이동 중까지 간 건수, transport.done : 도착까지 끝낸 건수
//   transport.fail.* : 어디서 왜 멈췄는지
const START = { lat: 36.815, lng: 127.1139 };
const APPROVAL_WAIT_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appApi(context, method, path, body, headers = {}) {
  const started = Date.now();
  const res = await fetch(`${context.vars.target}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${context.vars.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, ms: Date.now() - started };
}

export function runTransport(context, events, done) {
  const fail = (step, res) => {
    const code = res?.json?.error?.code ?? res?.status ?? 'none';
    events.emit('counter', `transport.fail.${step}.${code}`, 1);
  };
  const socket = io(`${context.vars.target}/app`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    auth: { token: context.vars.token },
  });
  // 이송을 만들기 전에 알림 듣기를 먼저 건다 (승인이 아주 빨리 와도 놓치지 않게)
  let transportId = null;
  let firstApproval = null;
  let onApproval = null;
  socket.on('request.approved', (envelope) => {
    const receivedAt = Date.now();
    if (firstApproval || envelope.data.transportId !== transportId) return;
    events.emit(
      'histogram',
      'transport.approved_notify_ms',
      receivedAt - Date.parse(envelope.occurredAt),
    );
    firstApproval = envelope.data;
    onApproval?.();
  });

  const run = async () => {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    transportId = randomUUID();
    const created = await appApi(context, 'POST', '/transports', {
      id: transportId,
      radiusKm: 10,
      location: START,
      locationConsent: true,
      assessment: { chiefComplaint: '흉통', sex: 'M', ageBand: '60s', consciousness: 'alert' },
    });
    events.emit('histogram', 'transport.create_ms', created.ms);
    if (created.status !== 201 || created.json?.status !== 'requesting') {
      fail(
        'create',
        created.status === 201 ? { json: { error: { code: created.json?.status } } } : created,
      );
      return;
    }

    if (!firstApproval) {
      await Promise.race([new Promise((r) => (onApproval = r)), sleep(APPROVAL_WAIT_MS)]);
    }
    if (!firstApproval) {
      fail('approval', { status: 'timeout' });
      return;
    }

    // 확정·도착에는 이송 건 version 이 필요하다. 앱처럼 '진행 중 이송 불러오기'로 받는다 (건별 조회 API 는 없다)
    const before = await appApi(context, 'GET', '/transports/current');
    const confirmed = await appApi(
      context,
      'POST',
      `/transports/${transportId}/confirm`,
      { hospitalRequestId: firstApproval.hospitalRequestId, version: before.json?.version },
      { 'Idempotency-Key': randomUUID() },
    );
    events.emit('histogram', 'transport.confirm_ms', confirmed.ms);
    if (confirmed.status !== 200) {
      fail('confirm', confirmed);
      return;
    }
    events.emit('counter', 'transport.moving', 1);

    // 이동 중으로 머무는 동안 다른 대원들의 이송이 겹쳐 '동시 진행 이송'이 쌓인다 (PER-007)
    await sleep(Number(context.vars.holdSeconds ?? 60) * 1000);

    const current = await appApi(context, 'GET', '/transports/current');
    const arrived = await appApi(context, 'POST', `/transports/${transportId}/arrive`, {
      method: 'button',
      version: current.json?.version,
    });
    events.emit('histogram', 'transport.arrive_ms', arrived.ms);
    if (arrived.status !== 200) {
      fail('arrive', arrived);
      return;
    }
    events.emit('counter', 'transport.done', 1);
  };

  run()
    .catch((err) => events.emit('counter', `transport.fail.error.${err.message}`, 1))
    .finally(() => {
      socket.disconnect();
      done();
    });
}

// ---- 위치 기록 (PER-008) ----
// 요청 직전에 '지금' 위치 1점을 만든다. 서버는 출발 1분 전 ~ 지금+1분 밖의 시각을 버리고,
// 같은 시각을 다시 보내면 한 번만 저장하므로 매번 지금 시각을 쓴다. 좌표는 천안 근처에서 조금씩 움직인다
export function locationBody(requestParams, context, _events, next) {
  const step = (context.vars.$loopCount ?? 0) + 1;
  requestParams.json = {
    deviceId: context.vars.deviceId,
    points: [
      {
        lat: 36.815 + step * 0.0003,
        lng: 127.1139 + step * 0.0002,
        speedKmh: 40,
        recordedAt: new Date().toISOString(),
      },
    ],
  };
  requestParams.headers = {
    ...requestParams.headers,
    Authorization: `Bearer ${context.vars.token}`,
  };
  return next();
}
