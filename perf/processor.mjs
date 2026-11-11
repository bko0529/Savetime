// Artillery 시나리오가 부르는 함수 (부하 테스트 연습, PER-005).
// 가상 사용자 1명 = 병원 PC 1대. 사용자마다 .pcs.csv 의 다른 쿠키로 /hospital 실시간 연결을 맺고 유지한다.
// Artillery 내장 Socket.IO 엔진은 사용자마다 다른 쿠키 헤더를 붙이기 어려워서, 프로젝트의 socket.io-client 로 직접 붙는다.
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL } from 'node:url';

// 저장소 루트의 node_modules 에서 찾는다 (서버가 쓰는 것과 같은 4.x)
const require = createRequire(new URL('../package.json', import.meta.url));
const { io } = require('socket.io-client');

const WEB_ORIGIN = process.env.PERF_ORIGIN ?? 'http://localhost:3000';

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
