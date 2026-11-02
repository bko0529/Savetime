// 주기 작업 틀: 서버가 몇 대든 같은 작업은 한 번만 실행한다 (COR-016, QUR-012)
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
}

export interface JobRunner {
  close: () => Promise<void>;
}

const KEEP_FINISHED_JOBS = 100;

// 작업마다 큐를 따로 둔다. 큐를 같이 쓰면 오래 걸리는 수집이 다른 주기 작업까지 막는다.
export function startScheduledJob(
  job: ScheduledJob,
  connection: ConnectionOptions,
  logger: Logger,
  prefix = 'bull',
): JobRunner {
  const queue = new Queue(job.name, { connection, prefix });
  const worker = new Worker(job.name, () => job.run(), { connection, prefix, autorun: false });

  // 이 처리기가 없으면 Redis가 잠깐 끊겼을 때 처리되지 않은 오류로 서버가 죽는다.
  queue.on('error', (err) => logger.error({ message: err.message }, '큐 오류'));
  worker.on('error', (err) => logger.error({ message: err.message }, '워커 오류'));
  worker.on('failed', (_job, err) => {
    logger.error({ job: job.name, message: err.message }, '주기 작업 실패');
  });

  const register = async (): Promise<void> => {
    // 같은 이름으로 몇 번을 등록해도 스케줄러는 1개다. 서버 2대가 각각 등록해도 안전하다.
    await queue.upsertJobScheduler(
      job.name,
      { every: job.everyMs },
      {
        name: job.name,
        opts: { removeOnComplete: KEEP_FINISHED_JOBS, removeOnFail: KEEP_FINISHED_JOBS },
      },
    );
    // 워커의 동시 실행 수는 서버마다 따로 계산되므로, 회차가 겹치지 않게 큐 전체를 1개로 묶는다.
    await queue.setGlobalConcurrency(1);
    await worker.run();
  };

  // Redis가 늦게 살아나도 서버는 뜨도록 기다리지 않는다. /health가 503을 내면 충분하다.
  register().catch((err: Error) => {
    logger.error({ job: job.name, message: err.message }, '주기 작업 등록 실패');
  });

  return {
    close: async () => {
      await worker.close(); // 실행 중인 작업이 끝나길 기다린다
      await queue.close();
    },
  };
}
