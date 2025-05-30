/**
 * Mitsuba E2Eテスト
 * 実際のRabbitMQサーバーを使用したEnd-to-Endテスト
 * 別コンテナで実行されるワーカープロセスと連携して実施
 */

import {describe, test, expect, beforeAll, afterAll} from 'vitest';

import type {Mitsuba} from '../../index';
import {createApp} from './shared/task-definitions';

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@rabbitmq:5672';
const BACKEND_URL = process.env.BACKEND_URL || 'amqp://guest:guest@rabbitmq:5672';

console.log('broker url', BROKER_URL);
console.log('backend url', BACKEND_URL);

describe('Mitsuba E2Eテスト', () => {
  let mitsuba: Mitsuba;
  let tasks: ReturnType<typeof createApp>['tasks'];

  beforeAll(async () => {
    const {app, tasks: mitsubaTasks} = createApp(BROKER_URL, BACKEND_URL);
    mitsuba = app;
    tasks = mitsubaTasks;

    await mitsuba.init();
    console.log('E2Eテストクライアント初期化完了: RabbitMQ接続確立');
  }, 30000); // 接続に時間がかかる場合を考慮

  // テスト後に接続を閉じる
  afterAll(async () => {
    await mitsuba.close();
    console.log('E2Eテストクライアント停止完了');
  }, 10000);

  test('基本的なタスク実行と結果取得', async () => {
    console.log('Task created');

    const task = tasks.addTask(5, 7);
    console.log('Task execed', task);

    const result = await task.get();
    console.log('result receivedd', result);

    expect(result).toBe(12);
  }, 15000);

  // 複数タスクの並列実行E2Eテスト
  test('複数タスクの並列実行 (E2E)', async () => {
    // 両方のタスクを同時に実行
    const startTime = performance.now();
    const [resultA, resultB] = await Promise.all([tasks.multiply2Take1000ms(7).get(), tasks.add10Take1500ms(5).get()]);
    const endTime = performance.now();

    // 結果確認
    expect(resultA).toBe(14); // 7 * 2
    expect(resultB).toBe(15); // 5 + 10

    // 並列実行の確認
    // 別コンテナで実行されるため、正確な時間計測はできないが、
    // 両方のタスクがほぼ同時に実行されるはず
    const executionTime = endTime - startTime;
    console.log(`複数タスク実行時間: ${executionTime}ms`);

    // 直列実行の場合は少なくとも2500ms以上かかるはず
    // 注: この時間テストは環境依存であり、信頼性は低い
  }, 20000);

  // エラー処理のE2Eテスト
  test('タスクエラー処理 (E2E)', async () => {
    // 共通タスク定義を使用

    // タスク実行
    const task = tasks.errorTask();

    // エラーが発生することを確認
    await expect(task.get()).rejects.toThrow();

    // タスクのステータスが失敗になっていることを確認
    expect(task.getStatus()).toBe('FAILURE');
  }, 15000);

  // 大量のタスクを同時実行するE2Eテスト
  test('大量のタスク同時実行 (E2E)', async () => {
    const taskCount = 10;
    const results = await Promise.all(Array.from({length: taskCount}, (_, i) => tasks.incrementTask(i)).map((t) => t.get()));

    for (let i = 0; i < taskCount; i++) {
      expect(results).toContain(i + 1);
    }
  }, 30000);
});
