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

  // ヘルパー関数: タスクを実行し、結果を待ってからワーカーを停止する
  async function executeTaskWithWorker<T>(
    tasks: Record<string, (...args: Array<unknown>) => any>,
    worker: {start: (concurrency?: number) => Promise<void>; stop: () => Promise<void>},
    taskName: string,
    args: Array<unknown>,
  ): Promise<T> {
    // ワーカーを起動
    await worker.start(1);

    // タスクを実行
    const task = tasks[taskName](...args);

    try {
      // 結果を待つ
      const result = await task.promise();
      return result as T;
    } finally {
      // 必ずワーカーを停止
      await worker.stop();
    }
  }

  // 基本的なタスク実行と結果取得のテスト
  test('基本的なタスク実行と結果取得', async () => {
    // 1. タスク定義
    const addTask = async (a: number, b: number) => a + b;

    // 2. タスクとワーカーの作成
    const {tasks, worker} = mitsuba.createTask({
      addTask,
    });

    // 3. タスク実行と結果取得
    const result = await executeTaskWithWorker(tasks, worker, 'addTask', [3, 4]);

    // 4. 結果確認
    expect(result).toBe(7);
  });

  // タスク結果のバックエンドからの取得テスト
  test('タスク結果のバックエンドからの取得', async () => {
    // 1. タスク定義と実行
    const multiplyTask = async (a: number, b: number) => a * b;

    const {tasks, worker} = mitsuba.createTask({
      multiplyTask,
    });

    // 2. タスク実行と結果取得
    const taskPromise = tasks.multiplyTask(5, 6);

    // 3. ワーカーを起動
    await worker.start(1);

    // 4. 結果を取得
    const result = await taskPromise.promise();

    // 5. ワーカーを明示的に停止
    await worker.stop();

    // 6. 結果確認
    expect(result).toBe(30);

    // 7. タスクIDを取得してバックエンドから直接確認
    const taskId = await (taskPromise as any).taskPromise;
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

    // 5. ワーカーを明示的に停止
    await worker.stop();

    // 6. 結果と状態を確認
    const successStatus = await task.status();
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

    // 2. タスク実行
    const task = tasks.testTask(10);

    // 3. ワーカーを起動して処理させる
    await worker.start(1);

    // 4. 一度成功することを確認
    const result = await task.promise();

    // 5. ワーカーを明示的に停止
    await worker.stop();

    expect(result).toBe(20);

    // 6. バックエンドの結果を消去して取得失敗を模擬
    mockBackend.clearResults();

    // 7. 再度取得を試みると例外が発生するはず
    try {
      await task.promise();
      // 例外が発生しなかった場合はテスト失敗
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(TaskRetrievalError);
    }
  });

  // ワーカーの並列実行テスト
  test('ワーカーの並列実行', async () => {
    // 1. 複数のタスク定義
    const taskA = async (name: string) => `Task A: ${name}`;
    const taskB = async (name: string) => `Task B: ${name}`;

    const {tasks, worker} = mitsuba.createTask({
      taskA,
      taskB,
    });

    // 2. 複数のタスクを実行
    const taskAPromise = tasks.taskA('test1');
    const taskBPromise = tasks.taskB('test2');

    // 3. ワーカーを並列数2で起動
    await worker.start(2);

    // 4. 全てのタスク完了を待つ
    const [resultA, resultB] = await Promise.all([taskAPromise.promise(), taskBPromise.promise()]);

    // 5. ワーカーを明示的に停止
    await worker.stop();

    // 6. 結果確認
    expect(resultA).toBe('Task A: test1');
    expect(resultB).toBe('Task B: test2');
  });
});
