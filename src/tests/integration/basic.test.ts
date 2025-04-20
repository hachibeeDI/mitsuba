/**
 * Mitsuba 基本機能の結合テスト
 */
import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {MockBroker} from '../mocks/broker.mock';
import {MockBackend} from '../mocks/backend.mock';
import {Mitsuba} from '../../index';
import {TaskRetrievalError} from '../../errors';

describe('Mitsuba 基本機能テスト', () => {
  // テスト用のモックとMitsubaインスタンス
  let mockBroker: MockBroker;
  let mockBackend: MockBackend;
  let mitsuba: Mitsuba;

  // 各テスト前にセットアップを実行
  beforeEach(async () => {
    mockBroker = new MockBroker();
    mockBackend = new MockBackend();

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
  });

  // モック結合テスト用ヘルパー関数：タスク実行結果をバックエンドに保存
  async function processTaskAndStoreResult(taskName: string, taskId: string, args: Array<unknown>): Promise<unknown> {
    // タスクのハンドラーを実行
    const registry = (mitsuba as any)._taskRegistry || {};
    const taskFn = registry[taskName];
    if (!taskFn) {
      throw new Error(`Task not found: ${taskName}`);
    }

    let result;
    if (typeof taskFn === 'function') {
      result = await taskFn(...args);
    } else {
      result = await taskFn.call(...args);
    }

    // 結果をバックエンドに保存
    await mockBackend.storeResult(taskId, result);
    return result;
  }

  // タスクレジストリを直接設定するヘルパー
  function setupTaskRegistry<T extends Record<string, unknown>>(mitsuba: Mitsuba, registry: T) {
    (mitsuba as any)._taskRegistry = registry;
  }

  // 基本的なタスク実行と結果取得のテスト
  test('基本的なタスク実行と結果取得', async () => {
    // 1. タスク定義
    const addTask = async (a: number, b: number) => a + b;
    setupTaskRegistry(mitsuba, {addTask});

    const tasks = mitsuba.createTask({
      addTask,
    });

    // 2. タスク実行をモック
    // ブローカーのpublishTaskをスパイして、タスクIDを取得
    const publishTaskSpy = vi.spyOn(mockBroker, 'publishTask');

    // タスク実行
    const task = tasks.addTask(3, 4);

    // publishTaskが呼ばれたことを確認
    expect(publishTaskSpy).toHaveBeenCalledWith('addTask', [3, 4], undefined);

    // タスクIDを取得
    const taskId = await publishTaskSpy.mock.results[0].value;

    // 3. タスク実行と結果保存をシミュレート
    await processTaskAndStoreResult('addTask', taskId, [3, 4]);

    // 4. 結果取得
    const result = await task.promise();

    // 5. 結果確認
    expect(result).toBe(7);
  });

  // タスク結果のバックエンドからの取得テスト
  test('タスク結果のバックエンドからの取得', async () => {
    // 1. タスク定義
    const multiplyTask = async (a: number, b: number) => a * b;
    setupTaskRegistry(mitsuba, {multiplyTask});

    const tasks = mitsuba.createTask({
      multiplyTask,
    });

    // 2. タスク実行をモック
    const publishTaskSpy = vi.spyOn(mockBroker, 'publishTask');
    const task = tasks.multiplyTask(5, 6);
    const taskId = await publishTaskSpy.mock.results[0].value;

    // 3. タスク実行と結果保存をシミュレート
    await processTaskAndStoreResult('multiplyTask', taskId, [5, 6]);

    // 4. 結果取得
    const result = await task.promise();

    // 5. 結果確認
    expect(result).toBe(30);

    // 6. バックエンドからも直接取得できることを確認
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
    setupTaskRegistry(mitsuba, {slowTask});

    const tasks = mitsuba.createTask({
      slowTask,
    });

    // 2. タスク実行
    const publishTaskSpy = vi.spyOn(mockBroker, 'publishTask');
    const task = tasks.slowTask(10);
    const taskId = await publishTaskSpy.mock.results[0].value;

    // ステータスを確認（結果が保存される前）
    const pendingStatus = await task.status();
    expect(pendingStatus).toBe('PENDING');

    // 3. タスク実行と結果保存をシミュレート
    await processTaskAndStoreResult('slowTask', taskId, [10]);

    // 4. タスク完了後のステータスと結果を確認
    const result = await task.promise();
    const successStatus = await task.status();

    expect(result).toBe(20);
    expect(successStatus).toBe('SUCCESS');
  });

  // タスク結果の取得失敗テスト
  test('タスク結果の取得失敗', async () => {
    // 1. タスク定義
    const testTask = async (value: number) => value * 2;
    setupTaskRegistry(mitsuba, {testTask});

    const tasks = mitsuba.createTask({
      testTask,
    });

    // 2. タスク実行
    const publishTaskSpy = vi.spyOn(mockBroker, 'publishTask');
    const task = tasks.testTask(10);
    const taskId = await publishTaskSpy.mock.results[0].value;

    // 3. タスク実行と結果保存をシミュレート
    await processTaskAndStoreResult('testTask', taskId, [10]);

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
});
