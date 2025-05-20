/**
 * Mitsuba E2Eテスト用ワーカープロセス
 * Docker環境内で実行される独立したワーカープロセス
 */

import {createApp} from '../shared/task-definitions';

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@rabbitmq:5672';
const BACKEND_URL = process.env.BACKEND_URL || 'amqp://guest:guest@rabbitmq:5672';
const WORKER_ID = process.env.WORKER_ID || 'worker-1';
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '3', 10);

/**
 * ワーカープロセスを起動する
 */
async function startWorker() {
  console.log(`Starting worker ${WORKER_ID} with concurrency ${CONCURRENCY}...`);

  const {app, worker} = createApp(BROKER_URL, BACKEND_URL);
  await app.init();

  try {
    // シグナルハンドリング
    process.on('SIGTERM', async () => {
      console.log(`Worker ${WORKER_ID} received SIGTERM, shutting down...`);
      await worker.stop();
      await app.close();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log(`Worker ${WORKER_ID} received SIGINT, shutting down...`);
      await worker.stop();
      await app.close();
      process.exit(0);
    });

    // 予期しない例外を処理
    process.on('uncaughtException', async (error) => {
      console.error(`Worker ${WORKER_ID} encountered an uncaught exception:`, error);
      await worker.stop();
      await app.close();
      process.exit(1);
    });

    console.log(`Worker ${WORKER_ID} running and waiting for tasks...`);

    await worker.start(CONCURRENCY);
    console.log(`Worker ${WORKER_ID} started with ${CONCURRENCY} concurrent processes`);
  } catch (error) {
    console.error(`Worker ${WORKER_ID} failed to start:`, error);
    process.exit(1);
  }
}

startWorker().catch((error) => {
  console.error('Fatal error starting worker:', error);
  process.exit(1);
});
