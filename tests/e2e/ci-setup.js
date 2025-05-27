#!/usr/bin/env node

/**
 * GitHub Actionsで実行される前に特別なセットアップをするためのスクリプト
 */

const {execSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

// CIかどうかを判定
const isCI = process.env.CI === 'true';

console.log(`Running in CI environment: ${isCI}`);
console.log(`OS: ${os.platform()} ${os.release()}`);
console.log('Docker version:');

try {
  // Dockerのバージョン情報を出力
  console.log(execSync('docker --version').toString());
  console.log(execSync('docker compose version').toString());
} catch (error) {
  console.error('Failed to get Docker version:', error.message);
}

// ホスト名解決のテスト
console.log('\nTesting hostname resolution:');
try {
  console.log('localhost resolution:');
  console.log(execSync('ping -c 1 localhost').toString());

  console.log('\nrabbitmq container resolution:');
  console.log(execSync('ping -c 1 rabbitmq || echo "Cannot resolve rabbitmq hostname"').toString());
} catch (error) {
  console.error('Error during hostname resolution test:', error.message);
}

// ネットワーク設定の確認
console.log('\nDocker network settings:');
try {
  console.log(execSync('docker network ls').toString());
} catch (error) {
  console.error('Failed to list Docker networks:', error.message);
}

// hosts ファイルに rabbitmq エントリを追加 (CIでの名前解決問題に対処)
if (isCI) {
  console.log('\nAdding rabbitmq and elasticmq to /etc/hosts in CI environment');
  try {
    // docker container inspect で IPアドレスを取得する方が良いが、
    // 簡易的な対応として 127.0.0.1 を使用
    const hostsEntry = '\n# Added for mitsuba e2e tests\n127.0.0.1 rabbitmq\n127.0.0.1 elasticmq\n';

    if (os.platform() === 'linux') {
      try {
        fs.appendFileSync('/etc/hosts', hostsEntry);
        console.log('Successfully added entries to /etc/hosts');
      } catch (error) {
        console.error('Failed to write to /etc/hosts directly:', error.message);
        console.log('Trying with sudo...');
        execSync(`echo "${hostsEntry}" | sudo tee -a /etc/hosts`);
      }
    } else {
      console.log('Not modifying /etc/hosts on non-Linux platform');
    }
  } catch (error) {
    console.error('Failed to modify hosts file:', error.message);
  }
}

// 環境変数をCIに合わせて更新
if (isCI) {
  console.log('\nUpdating environment variables for CI');

  // GitHub Actionsではコンテナに直接localhost経由でアクセスする
  process.env.BROKER_URL = 'amqp://guest:guest@localhost:5672';
  process.env.BACKEND_URL = 'amqp://guest:guest@localhost:5672';

  console.log(`BROKER_URL set to: ${process.env.BROKER_URL}`);
  console.log(`BACKEND_URL set to: ${process.env.BACKEND_URL}`);
}

// Dockerコンテナのステータスを表示
console.log('\nDocker container status:');
try {
  console.log(execSync('docker compose ps').toString());
} catch (error) {
  console.error('Failed to get container status:', error.message);
}

console.log('\nCI setup completed');
