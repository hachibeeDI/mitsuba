/**
 * Mitsuba E2Eテスト用ワーカープロセス
 * Docker環境内で実行される独立したワーカープロセス
 */

import {createApp} from '@tests/shared/task-definitions';

const BROKER_URL = process.env.BROKER_URL ?? '!!!!undefined!!!!!';
const BACKEND_URL = process.env.BACKEND_URL ?? '!!!!undefined!!!!!';
const WORKER_ID = process.env.WORKER_ID || 'worker-1';

const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '3', 10);
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000; // 3 seconds

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** */
async function tryConnect(retryCount = 0) {
  console.log(`Connection attempt ${retryCount + 1}/${MAX_RETRIES + 1}...`);

  try {
    const {app, worker} = createApp(BROKER_URL, BACKEND_URL);
    await app.init();
    console.log(`Successfully connected on attempt ${retryCount + 1}`);
    return {app, worker};
  } catch (error) {
    console.error(`Connection attempt ${retryCount + 1} failed:`, error);

    if (retryCount < MAX_RETRIES) {
      console.log(`Waiting ${RETRY_DELAY}ms before next attempt...`);
      await sleep(RETRY_DELAY);
      return tryConnect(retryCount + 1);
    }

    throw new Error(`Failed to connect after ${MAX_RETRIES + 1} attempts`);
  }
}

/**
 * ワーカープロセスを起動する
 */
async function startWorker() {
  console.log(`Starting worker ${WORKER_ID} with concurrency ${CONCURRENCY}...`);
  console.log(`BROKER_URL=${BROKER_URL}`, `BACKEND_URL=${BACKEND_URL}`);

  const {app, worker} = await tryConnect();

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
