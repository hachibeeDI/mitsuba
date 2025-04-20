/**
 * ブローカーモックの単体テスト
 */
import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {MockBroker} from '../mocks/broker.mock';
import type {TaskOptions} from '../../types';

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
    const taskName = 'testTask';
    const args = [1, 2, 3];
    const options: TaskOptions = {priority: 10};

    const taskId = await broker.publishTask(taskName, args, options);

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
    const taskHandler = async (task: unknown): Promise<unknown> => {
      await Promise.resolve();
      handlerResults.push(task);
      return 'processed';
    };

    // コンシューマー登録
    const queueName = 'testQueue';
    const consumerTag = await broker.consumeTask(queueName, taskHandler);

    // コンシューマータグが文字列であること
    expect(typeof consumerTag).toBe('string');

    // タスク発行（コンシューマーに自動的に送信される）
    await broker.publishTask(queueName, [1, 2]);

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
    const taskHandler = async (task: unknown): Promise<unknown> => {
      await Promise.resolve();
      handlerResults.push(task);
      return 'processed';
    };

    // コンシューマー登録
    const queueName = 'testQueue';
    const consumerTag = await broker.consumeTask(queueName, taskHandler);

    // コンシューマーをキャンセル
    await broker.cancelConsumer(consumerTag);

    // タスク発行（キャンセルしたのでハンドラは呼ばれないはず）
    await broker.publishTask(queueName, [1, 2]);

    // 少し待機
    await new Promise((resolve) => setTimeout(resolve, 10));

    // ハンドラが呼ばれていないことを確認
    expect(handlerResults.length).toBe(0);
  });

  // 接続していない状態でのエラーハンドリングテスト
  test('未接続状態でのエラーハンドリング', async () => {
    await broker.disconnect();

    // 未接続状態でタスク発行するとエラーになるはず
    await expect(() => broker.publishTask('test', [1])).rejects.toThrowError('Broker is not connected');

    // 未接続状態でコンシューマー登録するとエラーになるはず
    await expect(() =>
      broker.consumeTask('test', async (t) => {
        await Promise.resolve();
        // テストのためのダミーハンドラ（実際には呼ばれない）
        return t;
      }),
    ).rejects.toThrowError('Broker is not connected');

    // 未接続状態でコンシューマーキャンセルするとエラーになるはず
    await expect(() => broker.cancelConsumer('dummyTag')).rejects.toThrowError('Broker is not connected');
  });

  // パブリッシュ失敗時のエラーハンドリングテスト
  test('パブリッシュ失敗のシミュレーション', async () => {
    // パブリッシュ失敗をシミュレート
    broker.setShouldFailPublish(true);

    // タスク発行するとエラーになるはず
    await expect(() => broker.publishTask('test', [1])).rejects.toThrowError('Failed to publish task');

    // 失敗フラグを解除
    broker.setShouldFailPublish(false);

    // 正常にパブリッシュできるようになるはず
    const taskId = await broker.publishTask('test', [1]);
    expect(typeof taskId).toBe('string');
  });
});
