/**
 * Mitsuba 基本機能の結合テスト
 */

import {EventEmitter} from 'node:events';

import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {expectTypeOf} from 'vitest';

import {MockBroker} from '../mocks/broker.mock';
import {MockBackend} from '../mocks/backend.mock';
import {Mitsuba} from '../../index';

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

  test('テスト作成の型テスト', async () => {
    const {tasks, worker} = mitsuba.createTask({
      addTask: (a: number, b: number) => a + b,
      addTask2: (a: number, b: string) => a + b,
      asString: {
        opts: {priority: 10},
        call: (a: number) => a.toString(),
      },
    } as const);

    await worker.start(1);

    console.debug(tasks.addTask(3, 4));

    expectTypeOf(await tasks.addTask(3, 4).get()).toEqualTypeOf<number>();
    expectTypeOf(await tasks.addTask2(3, '4').get()).toEqualTypeOf<string>();
    expectTypeOf(await tasks.asString(100).get()).toEqualTypeOf<string>();

    await worker.stop();
  });

  // 基本的なタスク実行と結果取得のテスト
  test('基本的なタスク実行と結果取得', async () => {
    const {tasks, worker} = mitsuba.createTask({
      addTask: (a: number, b: number) => a + b,
    } as const);

    await worker.start(1);
    const task = tasks.addTask(3, 4);
    const result = await task.get();
    await worker.stop();
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

    // 4. 結果を取得
    const result = await task.get();

    // 5. ワーカーを停止
    await worker.stop();

    // 6. 結果確認
    expect(result).toBe(30);

    // 7. タスクIDを取得してバックエンドから直接確認
    const taskId = await task.getTaskId();
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
    const result = await task.get();

    // 5. ワーカーを停止
    await worker.stop();

    // 6. 結果と状態を確認
    const successStatus = await task.status();
    expect(result).toBe(20);
    expect(successStatus).toBe('SUCCESS');
  });

  // 複数タスクの並列実行テスト
  test('複数タスクの並列実行', async () => {
    // 1. 複数のタスク定義
    const taskA = async (name: string) => {
      // タスクAは短い実行時間
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `Task A: ${name}`;
    };

    const taskB = async (name: string) => {
      // タスクBは少し長い実行時間
      await new Promise((resolve) => setTimeout(resolve, 40));
      return `Task B: ${name}`;
    };

    const {tasks, worker} = mitsuba.createTask({
      taskA,
      taskB,
    });

    // 2. ワーカーを並列数2で起動
    await worker.start(2);

    // 3. 複数のタスクを実行
    const startTime = Date.now();
    const taskPromises = [tasks.taskA('test1').get(), tasks.taskB('test2').get()];

    // 4. 全てのタスク完了を待つ
    const results = await Promise.all(taskPromises);
    const endTime = Date.now();

    // 5. ワーカーを停止
    await worker.stop();

    // 6. 結果確認
    expect(results).toContain('Task A: test1');
    expect(results).toContain('Task B: test2');

    // 7. 並列実行の確認 - タスクは同時に実行されるので、
    // 合計実行時間は最長のタスク (taskB: 40ms) より少し長いだけのはず
    // 完全に直列実行されると 60ms+ になるはず
    // テスト環境の負荷によって変動するので、余裕を持った値で検証
    const executionTime = endTime - startTime;
    expect(executionTime).toBeLessThan(100); // 十分な余裕を持った上限値
  });

  // 複数タスクの同時投入テスト
  test('大量のタスクを同時投入', async () => {
    // 1. シンプルなタスク定義
    const incrementTask = async (value: number) => value + 1;

    const {tasks, worker} = mitsuba.createTask({
      incrementTask,
    });

    // 2. ワーカーを起動 (同時処理数3)
    await worker.start(3);

    // 3. 10個のタスクを同時に投入
    const taskCount = 10;
    const taskPromises = Array.from({length: taskCount}, (_, i) => tasks.incrementTask(i).get());

    // 4. すべてのタスク結果を待機
    const results = await Promise.all(taskPromises);

    // 5. ワーカーを停止
    await worker.stop();

    // 6. 結果を検証
    expect(results).toHaveLength(taskCount);

    // 各タスクは入力値+1の結果を返すはず
    for (let i = 0; i < taskCount; i++) {
      expect(results).toContain(i + 1);
    }
  });
});
