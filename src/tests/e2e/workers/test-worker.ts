/**
 * Mitsuba E2Eテスト用ワーカープロセス
 * Docker環境内で実行される独立したワーカープロセス
 */

import {createApp} from '../shared/task-definitions';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
const WORKER_ID = process.env.WORKER_ID || 'worker-1';
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '3', 10);

/**
 * 環境変数のバリデーション
 */
function validateEnvironment() {
  if (Number.isNaN(CONCURRENCY) || CONCURRENCY <= 0) {
    throw new Error(`無効なCONCURRENCY値: ${process.env.CONCURRENCY}`);
  }

  if (!RABBITMQ_URL.startsWith('amqp://')) {
    throw new Error(`無効なRABBITMQ_URL: ${RABBITMQ_URL}`);
  }
}

/**
 * ワーカープロセスを起動する
 */
async function startWorker() {
  console.log(`Starting worker ${WORKER_ID} with concurrency ${CONCURRENCY}...`);

  // 環境変数の検証
  validateEnvironment();

  const {app, worker} = createApp(RABBITMQ_URL, RABBITMQ_URL);
  await app.init();

  try {
    await worker.start(CONCURRENCY);
    console.log(`Worker ${WORKER_ID} started with ${CONCURRENCY} concurrent processes`);

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

    // keepalive（このプロセスを実行し続ける）
    console.log(`Worker ${WORKER_ID} running and waiting for tasks...`);
  } catch (error) {
    console.error(`Worker ${WORKER_ID} failed to start:`, error);
    process.exit(1);
  }
}

// プロセス起動
startWorker().catch((error) => {
  console.error('Fatal error starting worker:', error);
  process.exit(1);
});
