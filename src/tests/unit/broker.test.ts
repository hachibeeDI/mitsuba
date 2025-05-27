/**
 * ブローカーモックの単体テスト
 */

import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {MockBroker} from '../mocks/broker.mock';
import type {TaskOptions, TaskPayload, TaskHandlerResult, TaskName} from '@mitsuba/core';
import {generateTaskId} from '@mitsuba/core';

describe('MockBroker 単体テスト', () => {
  let broker: MockBroker;

  // 各テスト前にセットアップを実行
  beforeEach(async () => {
    broker = new MockBroker();
    await broker.connect();
  });

  // 各テスト後にクリーンアップを実行
  afterEach(async () => {
    await broker.disconnect();
  });

  // 接続状態の確認テスト
  test('接続状態の管理', async () => {
    // 接続済みの状態か確認
    expect(broker.isConnected()).toBe(true);

    // 切断
    await broker.disconnect();
    expect(broker.isConnected()).toBe(false);

    // 再接続
    await broker.connect();
    expect(broker.isConnected()).toBe(true);
  });

  // タスク発行テスト
  test('タスク発行と取得', async () => {
    // タスク発行
    const taskName = 'testTask' as TaskName;
    const args = [1, 2, 3];
    const options: TaskOptions = {priority: 10};
    const taskId = generateTaskId();

    await broker.publishTask(taskId, taskName, args, options);

    // タスクIDが文字列であること
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);

    // タスクデータの取得
    const taskData = broker.getTaskById(taskId);

    // タスクデータの検証
    expect(taskData).toBeDefined();
    expect(taskData?.taskName).toBe(taskName);
    expect(taskData?.args).toEqual(args);
    expect(taskData?.options).toEqual(options);
  });

  // タスク消費テスト
  test('タスクの消費と実行', async () => {
    // 消費ハンドラのモック
    const handlerResults: Array<unknown> = [];
    const taskHandler = async (task: TaskPayload): Promise<TaskHandlerResult> => {
      await Promise.resolve();
      handlerResults.push(task);
      return {
        status: 'processed',
        taskId: task.id,
        result: 'processed',
      };
    };

    // コンシューマー登録
    const queueName = 'testQueue' as TaskName;
    const consumerTag = await broker.consumeTask(queueName, taskHandler);

    // コンシューマータグが文字列であること
    expect(typeof consumerTag).toBe('string');

    const taskId = generateTaskId();
    await broker.publishTask(taskId, queueName, [1, 2]);

    // ハンドラが呼ばれるのを待つ（即時実行の場合でも非同期）
    await new Promise((resolve) => setTimeout(resolve, 10));

    // ハンドラが呼ばれたことを確認
    expect(handlerResults.length).toBe(1);
    expect((handlerResults[0] as any).taskName).toBe(queueName);
    expect((handlerResults[0] as any).args).toEqual([1, 2]);
  });

  // コンシューマーキャンセルテスト
  test('コンシューマーのキャンセル', async () => {
    // 消費ハンドラのモック
    const handlerResults: Array<unknown> = [];
    const taskHandler = async (task: TaskPayload): Promise<TaskHandlerResult> => {
      await Promise.resolve();
      handlerResults.push(task);
      return {
        status: 'processed',
        taskId: task.id,
        result: 'processed',
      };
    };

    // コンシューマー登録
    const queueName = 'testQueue' as TaskName;
    const consumerTag = await broker.consumeTask(queueName, taskHandler);

    // コンシューマーをキャンセル
    await broker.cancelConsumer(consumerTag);

    const taskId = generateTaskId();
    // タスク発行（キャンセルしたのでハンドラは呼ばれないはず）
    await broker.publishTask(taskId, queueName, [1, 2]);

    // 少し待機
    await new Promise((resolve) => setTimeout(resolve, 10));

    // ハンドラが呼ばれていないことを確認
    expect(handlerResults.length).toBe(0);
  });

  // パブリッシュ失敗時のエラーハンドリングテスト
  test('パブリッシュ失敗のシミュレーション', async () => {
    // パブリッシュ失敗をシミュレート
    broker.setShouldFailPublish(true);

    // タスク発行するとエラーになるはず
    const taskIdx = generateTaskId();
    await expect(() => broker.publishTask(taskIdx, 'test' as TaskName, [1])).rejects.toThrowError('Failed to publish task');

    // 失敗フラグを解除
    broker.setShouldFailPublish(false);

    // 正常にパブリッシュできるようになるはず
    const taskIdy = generateTaskId();
    await broker.publishTask(taskIdy, 'test' as TaskName, [1]);
  });
});
