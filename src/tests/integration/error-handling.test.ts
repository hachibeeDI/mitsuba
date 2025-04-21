/**
 * Mitsuba エラーハンドリング統合テスト
 * 実際のRabbitMQサーバーは使用せず、同一プロセス内でワーカーとクライアントを統合テスト
 */

import {describe, test, expect, beforeAll, afterAll} from 'vitest';
import {Mitsuba} from '../../index';
import {testTasks} from '../e2e/shared/task-definitions';
import EventEmitter from 'node:events';
import { MockBroker } from '../mocks/broker.mock';
import { MockBackend } from '../mocks/backend.mock';


describe('Mitsuba エラーハンドリング統合テスト', () => {
  let mitsuba: Mitsuba;
  let mockBroker: MockBroker;
  let mockBackend: MockBackend;

  beforeAll(async () => {
    const messageQueue = new EventEmitter();
    messageQueue.setMaxListeners(100);

    messageQueue.setMaxListeners(100);
    mockBroker = new MockBroker(messageQueue);
    mockBackend = new MockBackend(messageQueue);

    mitsuba = new Mitsuba('integration-error-test', {
      broker: mockBroker,
      backend: mockBackend,
    });

    await mitsuba.init();
  }, 10000);

  // テスト後に接続を閉じる
  afterAll(async () => {
    await mitsuba.close();
  }, 5000);

  // 基本的なタスクエラー処理のテスト
  test('基本的なタスクエラー処理', async () => {
    // エラーを発生させるタスク（共通タスク定義を使用）
    const {tasks, worker} = mitsuba.createTask({
      throwErrorTask: () => {
        throw new Error('意図的なエラー');
      },
    });

    // 同じプロセス内でワーカーを起動
    await worker.start(1);

    // タスク実行
    const task = tasks.throwErrorTask();

    // エラーが発生することを確認
    await expect(task.get()).rejects.toThrow('意図的なエラー');

    // タスクのステータスがエラー状態になっていることを確認
    expect(task.status).toBe('FAILURE');

    // ワーカーを停止
    await worker.stop();
  });

  // 非同期タスクエラー処理のテスト
  test('非同期タスクエラー処理', async () => {
    // 非同期処理でエラーを発生させるタスク
    const {tasks, worker} = mitsuba.createTask({
      asyncErrorTask: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error('非同期処理中のエラー');
      },
    });

    // ワーカーを起動
    await worker.start(1);

    // タスク実行
    const task = tasks.asyncErrorTask();

    // エラーが発生することを確認
    await expect(task.get()).rejects.toThrow('非同期処理中のエラー');

    // タスクのステータスがエラー状態になっていることを確認
    expect(task.status).toBe('FAILURE');

    // ワーカーを停止
    await worker.stop();
  });

  // 複数のエラーを含むタスク実行
  test('複数のエラータスク混在処理', async () => {
    // 成功するタスクと失敗するタスクを混在して定義
    const {tasks, worker} = mitsuba.createTask({
      // 成功タスク
      successTask: (value: string) => `成功: ${value}`,

      // 失敗タスク
      failureTask: () => {
        throw new Error('失敗タスク');
      },

      // 条件付き失敗タスク
      conditionalTask: (shouldFail: boolean) => {
        if (shouldFail) {
          throw new Error('条件付き失敗');
        }
        return '条件付きタスク成功';
      },
    });

    // ワーカーを起動
    await worker.start(2);

    // 様々なタスクを実行
    const successTask = tasks.successTask('テスト');
    const failureTask = tasks.failureTask();
    const conditionalSuccess = tasks.conditionalTask(false);
    const conditionalFailure = tasks.conditionalTask(true);

    // 成功するタスクの結果を確認
    const successResult = await successTask.get();
    expect(successResult).toBe('成功: テスト');
    expect(successTask.status).toBe('SUCCESS');

    // 条件付き成功タスクの結果を確認
    const conditionalSuccessResult = await conditionalSuccess.get();
    expect(conditionalSuccessResult).toBe('条件付きタスク成功');
    expect(conditionalSuccess.status).toBe('SUCCESS');

    // 失敗するタスクでエラーが発生することを確認
    await expect(failureTask.get()).rejects.toThrow('失敗タスク');
    expect(failureTask.status).toBe('FAILURE');

    // 条件付き失敗タスクでエラーが発生することを確認
    await expect(conditionalFailure.get()).rejects.toThrow('条件付き失敗');
    expect(conditionalFailure.status).toBe('FAILURE');

    // ワーカーを停止
    await worker.stop();
  });

  // エラー後の冪等性テスト - 共通定義を使用
  test('エラー後の冪等性', async () => {
    const {tasks, worker} = mitsuba.createTask(testTasks);

    // ワーカーを起動
    await worker.start(1);

    // 1回目の呼び出し（エラーになるはず）
    const firstTask = tasks.firstCallErrorTask(1);
    await expect(firstTask.get()).rejects.toThrow('初回呼び出しエラー');

    // 2回目の呼び出し（成功するはず）
    const secondTask = tasks.firstCallErrorTask(2);
    const result = await secondTask.get();

    expect(result).toBe('成功: 2回目の呼び出し');

    // ワーカーを停止
    await worker.stop();
  });

  // 無効なタスク呼び出しのテスト
  test('無効なタスク呼び出し', async () => {
    // タスクを定義せずにワーカーを起動
    const {worker} = mitsuba.createTask({});

    await worker.start(1);

    // テスト実行後のクリーンアップ
    await worker.stop();
  });
}); 