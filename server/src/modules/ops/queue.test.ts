// 실제 Redis로 서버 2대 상황을 흉내 낸다. 키 앞머리를 테스트마다 달리해 개발 데이터와 섞이지 않게 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { TEST_REDIS_URL } from '../../testing/services.js';
import { startScheduledJob, type ScheduledJob } from './queue.js';

const logger = pino({ level: 'silent' });
const connection = { url: TEST_REDIS_URL };

function newPrefix(): string {
  return `test-${randomBytes(6).toString('hex')}`;
}

async function cleanUp(prefix: string): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL);
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(keys);
  await redis.quit();
}

test('서버 2대가 같은 작업을 등록해도 주기마다 1번만 실행된다', async () => {
  const prefix = newPrefix();
  let runs = 0;
  const job: ScheduledJob = {
    name: 'test-once',
    everyMs: 300,
    run: async () => {
      runs += 1;
    },
  };

  const first = startScheduledJob(job, connection, logger, prefix);
  const second = startScheduledJob(job, connection, logger, prefix);
  await sleep(1650);
  await Promise.all([first.close(), second.close()]);
  await cleanUp(prefix);

  // 1650ms ÷ 300ms = 약 5회. 중복 실행이면 2배 가까이 된다.
  assert.ok(runs >= 3 && runs <= 6, `실행 횟수 ${runs}`);
});

test('앞 회차가 길어지면 서버가 2대여도 겹쳐 실행되지 않는다', async () => {
  const prefix = newPrefix();
  let running = 0;
  let maxRunning = 0;
  const job: ScheduledJob = {
    name: 'test-overlap',
    everyMs: 100,
    run: async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(350);
      running -= 1;
    },
  };

  const first = startScheduledJob(job, connection, logger, prefix);
  const second = startScheduledJob(job, connection, logger, prefix);
  await sleep(1500);
  await Promise.all([first.close(), second.close()]);
  await cleanUp(prefix);

  assert.equal(maxRunning, 1);
});

test('close는 실행 중인 작업이 끝날 때까지 기다린다', async () => {
  const prefix = newPrefix();
  let started = false;
  let finished = false;
  const runner = startScheduledJob(
    {
      name: 'test-close',
      everyMs: 100,
      run: async () => {
        started = true;
        await sleep(400);
        finished = true;
      },
    },
    connection,
    logger,
    prefix,
  );

  while (!started) await sleep(20);
  await runner.close();
  await cleanUp(prefix);

  assert.equal(finished, true);
});

test('작업이 실패해도 다음 주기에 다시 실행된다', async () => {
  const prefix = newPrefix();
  let runs = 0;
  const runner = startScheduledJob(
    {
      name: 'test-failure',
      everyMs: 100,
      run: async () => {
        runs += 1;
        throw new Error('수집 실패');
      },
    },
    connection,
    logger,
    prefix,
  );

  await sleep(600);
  await runner.close();
  await cleanUp(prefix);

  assert.ok(runs >= 2, `실행 횟수 ${runs}`);
});
