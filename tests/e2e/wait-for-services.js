#!/usr/bin/env node

/**
 * サービスの起動を待機するスクリプト
 * CI環境でのタイミング問題を解決するために使用
 */

const {execSync} = require('node:child_process');
const net = require('node:net');

// 最大試行回数
const MAX_RETRIES = 30;
// 試行間の待機時間（ミリ秒）
const RETRY_INTERVAL = 2000;

/**
 * 指定したミリ秒だけ待機する
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TCPポートが開いているかどうかを確認する
 */
function checkTcpPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onError = () => {
      socket.destroy();
      resolve(false);
    };

    socket.setTimeout(1000);
    socket.once('error', onError);
    socket.once('timeout', onError);

    socket.connect(port, host, () => {
      socket.end();
      resolve(true);
    });
  });
}

/**
 * RabbitMQサーバーが実行中かどうかを確認する
 */
async function checkRabbitMQ(host = 'localhost') {
  console.log(`Checking RabbitMQ on ${host}:5672...`);

  // AMQPポートをチェック
  const amqpReady = await checkTcpPort(host, 5672);
  if (!amqpReady) {
    return false;
  }

  // 管理UIポートをチェック
  const managementReady = await checkTcpPort(host, 15672);

  return amqpReady && managementReady;
}

/**
 * ElasticMQ（SQSエミュレーター）が実行中かどうかを確認する
 */
async function checkElasticMQ(host = 'localhost') {
  console.log(`Checking ElasticMQ on ${host}:9324...`);

  // SQSポートをチェック
  return await checkTcpPort(host, 9324);
}

/**
 * Dockerコンテナが実行中かどうかを確認する
 */
function checkDockerContainer(containerName) {
  try {
    const output = execSync(`docker compose ps ${containerName} --format json`);
    const containerInfo = JSON.parse(output.toString());

    // コンテナが実行中かどうかをチェック
    return containerInfo.some((container) => container.State === 'running' || container.State === 'running(healthy)');
  } catch (error) {
    console.error(`Error checking container ${containerName}:`, error.message);
    return false;
  }
}

/**
 * すべてのサービスが実行中になるまで待機する
 */
async function waitForServices() {
  console.log('Waiting for services to be ready...');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`\nAttempt ${attempt}/${MAX_RETRIES}`);

    const rabbitMQReady = await checkRabbitMQ('localhost');
    const elasticMQReady = await checkElasticMQ('localhost');
    const workerReady = checkDockerContainer('worker');

    console.log(`RabbitMQ ready: ${rabbitMQReady}`);
    console.log(`ElasticMQ ready: ${elasticMQReady}`);
    console.log(`Worker ready: ${workerReady}`);

    if (rabbitMQReady && elasticMQReady && workerReady) {
      console.log('\nAll services are ready!');
      return true;
    }

    console.log(`Waiting ${RETRY_INTERVAL / 1000} seconds before next check...`);
    await sleep(RETRY_INTERVAL);
  }

  console.error(`\nServices did not become ready within ${(MAX_RETRIES * RETRY_INTERVAL) / 1000} seconds`);
  return false;
}

// メイン実行
waitForServices().then((allReady) => {
  if (!allReady) {
    console.error('Failed to wait for services, exiting');
    process.exit(1);
  }
});
