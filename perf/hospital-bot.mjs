// 병원 역할 봇 (PER-006 앞쪽 절반: 요청 → 병원 알림 3초).
// transports.yml 을 돌리는 동안 따로 켜 둔다. perf/.dispatch-pcs.csv 의 PC 마다 /hospital 에 붙어
//   1) 알림을 켜고(alarm.resume, 실제 병원 웹의 '알림 켜기'와 같은 방에 들어간다)
//   2) request.new 를 받으면 바로 '받았음'(ack)을 보내고 걸린 시간을 잰다
//   3) 1~3초 뒤(사람이 화면을 보고 누르는 시간) 요청 상세를 읽고 승인한다
// 끝나면(시간이 다 되거나 Ctrl+C) 알림 지연 p50·p95·최대와 승인 결과를 출력하고 perf/results/hospital-bot.json 에 쓴다.
//
// 실행: PERF_TARGET=http://localhost:4000 PERF_ORIGIN=http://localhost:3000 node perf/hospital-bot.mjs [초, 기본 300]
//
// 지연 = 받은 시각 − 요청 회차를 보낸 DB 시각. 회차의 응답 마감(respondUntil)은 보낸 시각 + 2분으로 DB 에서 정해지므로
// (requestTargets.ts insertRound) 받은 값에서 2분을 빼면 보낸 시각이 된다. 이송 만들기 트랜잭션 → 커밋 → 전송까지 모두 들어간다.
// 같은 컴퓨터면 시계가 같고, S8 클라우드에서는 두 서버가 NTP 로 맞춘 시계를 쓴다(오차 수 ms).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const { io } = require('socket.io-client');

const TARGET = process.env.PERF_TARGET ?? 'http://localhost:4000';
const ORIGIN = process.env.PERF_ORIGIN ?? 'http://localhost:3000';
const DURATION_S = Number(process.argv[2] ?? 300);
const RESPOND_WINDOW_MS = 2 * 60 * 1000;
const NOTIFY_GOAL_MS = 3000;

const csv = readFileSync(new URL('./.dispatch-pcs.csv', import.meta.url), 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [cookie, shiftId] = line.split(',');
    return { cookie, shiftId: Number(shiftId) };
  });

const notifyMs = [];
const approveCodes = {};
const counters = { connected: 0, alarmOn: 0, alarmOff: 0, connectError: 0, dropped: 0 };
const count = (obj, key) => (obj[key] = (obj[key] ?? 0) + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pc, method, path, body) {
  const res = await fetch(`${TARGET}/api/v1${path}`, {
    method,
    headers: {
      Cookie: pc.cookie,
      Origin: ORIGIN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// 사람이 확인하고 누르는 시간만큼 기다렸다가 승인한다. 이미 다른 병원이 확정됐으면 409 가 정상이다
async function approve(pc, requestId) {
  await sleep(1000 + Math.random() * 2000);
  try {
    const detail = await api(pc, 'GET', `/hw/requests/${requestId}`);
    if (detail.status !== 200) {
      count(approveCodes, `detail_${detail.status}_${detail.json?.error?.code ?? ''}`);
      return;
    }
    const res = await api(pc, 'POST', `/hw/requests/${requestId}/approve`, {
      version: detail.json.version,
      overApprovalConfirmed: true,
    });
    count(
      approveCodes,
      res.status === 200 ? '200' : `${res.status}_${res.json?.error?.code ?? ''}`,
    );
  } catch (err) {
    count(approveCodes, `error_${err.message}`);
  }
}

function connect(pc) {
  const socket = io(`${TARGET}/hospital`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    extraHeaders: { Cookie: pc.cookie, Origin: ORIGIN },
  });
  socket.once('connect', () => {
    counters.connected += 1;
    socket.emit('alarm.resume', { shiftId: pc.shiftId }, (res) => {
      if (res?.ok) counters.alarmOn += 1;
      else console.error('알림 켜기 실패 — perf:dispatch 를 다시 돌려 주세요');
    });
  });
  socket.once('connect_error', (err) => {
    counters.connectError += 1;
    console.error(`연결 실패: ${err.message}`);
  });
  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') counters.dropped += 1;
  });
  // 5초 안에 ack 하지 않으면 서버가 이 PC 의 알림을 끈다 (SFR-161). 늦게 끝난 것이 아닌지 보려고 센다
  socket.on('hospital.alarm_off', () => {
    counters.alarmOff += 1;
  });
  socket.on('request.new', (envelope, ack) => {
    const receivedAt = Date.now();
    if (typeof ack === 'function') ack();
    const sentAt = Date.parse(envelope.data.respondUntil) - RESPOND_WINDOW_MS;
    notifyMs.push(receivedAt - sentAt);
    void approve(pc, envelope.data.requestId);
  });
  return socket;
}

const pct = (sorted, p) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
    : null;

function summary() {
  const sorted = [...notifyMs].sort((a, b) => a - b);
  return {
    pcs: csv.length,
    ...counters,
    notified: sorted.length,
    notifyMs: {
      p50: pct(sorted, 50),
      p95: pct(sorted, 95),
      p99: pct(sorted, 99),
      max: sorted.at(-1) ?? null,
      overGoal: sorted.filter((ms) => ms > NOTIFY_GOAL_MS).length,
    },
    approve: approveCodes,
  };
}

const sockets = csv.map(connect);
console.log(
  `병원 PC ${csv.length}대 연결 중… ${DURATION_S}초 동안 요청을 받아 승인해요 (Ctrl+C 로 일찍 끝내기)`,
);

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  // 마지막 승인이 끝나도록 잠깐 기다린다
  await sleep(4000);
  for (const s of sockets) s.disconnect();
  const result = summary();
  console.log(JSON.stringify(result, null, 2));
  const dir = fileURLToPath(new URL('./results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}hospital-bot.json`, JSON.stringify(result, null, 2));
  process.exit(result.notifyMs.p95 !== null && result.notifyMs.p95 > NOTIFY_GOAL_MS ? 1 : 0);
}
process.on('SIGINT', finish);
setTimeout(finish, DURATION_S * 1000);
