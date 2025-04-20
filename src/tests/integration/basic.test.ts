/**
 * Mitsuba 基本機能の結合テスト
 */
import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {MockBroker} from '../mocks/broker.mock';
import {MockBackend} from '../mocks/backend.mock';
import {Mitsuba} from '../../index';
import {TaskRetrievalError} from '../../errors';

describe('Mitsuba 基本機能テスト', () => {
  // テスト用のモックとMitsubaインスタンス
  let mockBroker: MockBroker;
  let mockBackend: MockBackend;
  let mitsuba: Mitsuba;
  let messageQueue: EventEmitter;

  // 各テスト前にセットアップを実行
  beforeEach(async () => {
    // 共有EventEmitterを作成
    messageQueue = new EventEmitter();
    messageQueue.setMaxListeners(100);

    // 共有EventEmitterを使ってモックを作成
    mockBroker = new MockBroker(messageQueue);
    mockBackend = new MockBackend(messageQueue);

    // モックに接続
    await mockBroker.connect();
    await mockBackend.connect();

    // Mitsubaインスタンス作成
    mitsuba = new Mitsuba('test-app', {
      broker: mockBroker,
      backend: mockBackend,
    });

    // Mitsubaの初期化
    await mitsuba.init();
  });

  // 各テスト後にクリーンアップを実行
  afterEach(async () => {
    // Mitsubaの停止
    await mitsuba.close();

    // モックのクリーンアップ
    mockBroker.clearTasks();
    mockBackend.clearResults();
    await mockBroker.disconnect();
    await mockBackend.disconnect();

    // メッセージキューのクリーンアップ
    messageQueue.removeAllListeners();
  });

  // 基本的なタスク実行と結果取得のテスト
  test('基本的なタスク実行と結果取得', async () => {
    // 1. タスク定義
    const addTask = async (a: number, b: number) => a + b;

    // 2. タスクとワーカーの作成
    const {tasks, worker} = mitsuba.createTask({
      addTask,
    });

    // 3. ワーカーを起動 (非同期で実行)
    await worker.start(1);

    // 4. タスク実行
    const task = tasks.addTask(3, 4);

    // 5. 結果取得
    const result = await task.promise();

    // 6. 結果確認
    expect(result).toBe(7);
  });

  // タスク結果のバックエンドからの取得テスト
  test('タスク結果のバックエンドからの取得', async () => {
    // 1. タスク定義と実行
    const multiplyTask = async (a: number, b: number) => a * b;

    const {tasks, worker} = mitsuba.createTask({
      multiplyTask,
    });

    // 2. ワーカーを起動
    await worker.start(1);

    // 3. タスク実行
    const task = tasks.multiplyTask(5, 6);

    // 4. 結果取得
    const result = await task.promise();

    // 5. 結果確認
    expect(result).toBe(30);

    // 6. タスクIDを取得してバックエンドから直接確認
    const taskId = await (task as any).taskPromise;
    const resultFromBackend = await mockBackend.getResult(taskId);
    expect(resultFromBackend).toBe(30);
  });

  // タスクのステータス確認テスト
  test('タスクのステータス確認', async () => {
    // 1. タスク定義
    const slowTask = async (value: number) => {
      // 少し待機するタスク
      await new Promise((resolve) => setTimeout(resolve, 50));
      return value * 2;
    };

    const {tasks, worker} = mitsuba.createTask({
      slowTask,
    });

    // 2. タスク実行 (ワーカーを起動する前)
    const task = tasks.slowTask(10);

    // ステータスを確認（結果が保存される前）
    const pendingStatus = await task.status();
    expect(pendingStatus).toBe('PENDING');

    // 3. ワーカーを起動して処理させる
    await worker.start(1);

    // 4. タスク完了を待って状態を確認
    const result = await task.promise();
    const successStatus = await task.status();

    // 5. 結果確認
    expect(result).toBe(20);
    expect(successStatus).toBe('SUCCESS');
  });

  // タスク結果の取得失敗テスト
  test('タスク結果の取得失敗', async () => {
    // 1. タスク定義と実行
    const testTask = async (value: number) => value * 2;

    const {tasks, worker} = mitsuba.createTask({
      testTask,
    });

    // 2. ワーカーを起動して処理させる
    await worker.start(1);

    // 3. タスク実行
    const task = tasks.testTask(10);

    // 一度成功することを確認
    const result = await task.promise();
    expect(result).toBe(20);

    // 4. バックエンドの結果を消去して取得失敗を模擬
    mockBackend.clearResults();

    // 5. 再度取得を試みると例外が発生するはず
    try {
      await task.promise();
      // 例外が発生しなかった場合はテスト失敗
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(TaskRetrievalError);
    }
  });

  // ワーカーのスタートと実行テスト
  test('ワーカーの並列実行', async () => {
    // 1. 複数のタスク定義
    const taskA = async (name: string) => `Task A: ${name}`;
    const taskB = async (name: string) => `Task B: ${name}`;

    const {tasks, worker} = mitsuba.createTask({
      taskA,
      taskB,
    });

    // 2. ワーカーを並列数2で起動
    await worker.start(2);

    // 3. 複数のタスクを同時に実行
    const taskAPromise = tasks.taskA('test1').promise();
    const taskBPromise = tasks.taskB('test2').promise();

    // 4. 全てのタスク完了を待つ
    const [resultA, resultB] = await Promise.all([taskAPromise, taskBPromise]);

    // 5. 結果確認
    expect(resultA).toBe('Task A: test1');
    expect(resultB).toBe('Task B: test2');
  });
});
