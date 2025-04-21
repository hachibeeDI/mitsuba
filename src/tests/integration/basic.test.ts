/**
 * Mitsuba 基本機能の結合テスト
 */

import {EventEmitter} from 'node:events';

import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {expectTypeOf} from 'vitest';

import {MockBroker} from '../mocks/broker.mock';
import {MockBackend} from '../mocks/backend.mock';
import {Mitsuba} from '../../index';
import type {TaskResult} from '../../types';

describe('Mitsuba 基本機能テスト', () => {
  // テスト用のモックとMitsubaインスタンス
  let mockBroker: MockBroker;
  let mockBackend: MockBackend;
  let mitsuba: Mitsuba;

  // 各テスト前にセットアップを実行
  beforeEach(async () => {
    const messageQueue = new EventEmitter();
    messageQueue.setMaxListeners(100);

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

    expectTypeOf(await tasks.addTask(3, 4).getResult()).toEqualTypeOf<TaskResult<number>>();
    expectTypeOf(await tasks.addTask2(3, '4').getResult()).toEqualTypeOf<TaskResult<string>>();
    expectTypeOf(await tasks.asString(100).getResult()).toEqualTypeOf<TaskResult<string>>();

    await worker.stop();
  });

  // 基本的なタスク実行と結果取得のテスト
  test('基本的なタスク実行と結果取得', async () => {
    const {tasks, worker} = mitsuba.createTask({
      addTask: (a: number, b: number) => a + b,
    } as const);

    await worker.start(1);
    const task = tasks.addTask(3, 4);
    const result = await task.getResult();
    await worker.stop();
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.value).toBe(7);
    }
  });

  // タスク結果のバックエンドからの取得テスト
  test('タスク結果のバックエンドからの取得', async () => {
    // 1. タスク定義と実行
    const multiplyTask = async (a: number, b: number) => a * b;

    const {tasks, worker} = mitsuba.createTask({
      multiplyTask,
    });

    await worker.start(1);

    console.log('-----------------------1');
    const task = tasks.multiplyTask(5, 6);

    console.log('-----------------------2');
    // const result = await task.getResult();

    // console.log('-----------------------3');
    // expect(result.status).toBe('success');
    // if (result.status === 'success') {
    //   expect(result.value).toBe(30);
    // }

    console.log('-----------------------4');
    // 7. タスクIDを取得してバックエンドから直接確認
    const taskId = await task.getTaskId();
    console.log('-----------------------5');
    const resultFromBackend = await mockBackend.getResult(taskId);
    console.log('-----------------------6');
    expect(resultFromBackend.status).toBe('success');
    if (resultFromBackend.status === 'success') {
      expect(resultFromBackend.value).toBe(30);
    }

    await worker.stop();
  });

  // タスクのステータス確認テスト
  test('タスクのステータス確認', async () => {
    const {tasks, worker} = mitsuba.createTask({
      slowTask: async (value: number) => {
        // 少し待機するタスク
        await new Promise((resolve) => setTimeout(resolve, 50));
        return value * 2;
      },
    });

    await worker.start(1);
    const task = tasks.slowTask(10);

    // Note: ステータスチェックはタイミングによってはすでにSUCCESSになっている可能性がある
    const pendingStatus = await task.getStatus();
    // 結果を待たずにすぐにステータスを取得するので、PENDING または STARTED の可能性がある
    expect(['PENDING', 'STARTED', 'SUCCESS']).toContain(pendingStatus);

    const result = await task.getResult();

    const successStatus = await task.getStatus();
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.value).toBe(20);
    }
    expect(successStatus).toBe('SUCCESS');

    await worker.stop();
  });

  // 複数タスクの並列実行テスト
  test('複数タスクの並列実行', async () => {
    // FIXME: it depends on the test environment, but looks like too long
    const DEFAULT_DELAY = 50 + 10;

    const TASK_A_TIME = 90;
    const TASK_B_TIME = 100;

    // 1. 複数のタスク定義
    const {tasks, worker} = mitsuba.createTask({
      taskA: async (name: string) => {
        // タスクAは短い実行時間
        await new Promise((resolve) => setTimeout(resolve, TASK_A_TIME));
        return `Task A: ${name}`;
      },
      taskB: async (name: string) => {
        // タスクBは少し長い実行時間
        await new Promise((resolve) => setTimeout(resolve, TASK_B_TIME));
        return `Task B: ${name}`;
      },
    });

    // 2. ワーカーを並列数2で起動
    await worker.start(2);

    // 3. 複数のタスクを実行
    const startTime = performance.now();
    const taskResults = await Promise.all([tasks.taskA('test1').getResult(), tasks.taskB('test2').getResult()]);
    const endTime = performance.now();

    await worker.stop();

    // 6. 結果確認
    const results = taskResults.map((result) => {
      expect(result.status).toBe('success');
      return result.status === 'success' ? result.value : '';
    });
    expect(results).toContain('Task A: test1');
    expect(results).toContain('Task B: test2');

    // 7. 並列実行の確認 - タスクは同時に実行されるので、
    // 合計実行時間は最長のタスク (taskB: 40ms) より少し長いだけのはず
    // 完全に直列実行されると 60ms+ になるはず
    // テスト環境の負荷によって変動するので、余裕を持った値で検証
    const executionTime = endTime - startTime;
    expect(executionTime).toBeLessThan(TASK_B_TIME + DEFAULT_DELAY); // 十分な余裕を持った上限値
  });

  // 複数タスクの同時投入テスト
  test('大量のタスクを同時投入', async () => {
    // 1. シンプルなタスク定義
    const {tasks, worker} = mitsuba.createTask({
      incrementTask: async (value: number) => value + 1,
    });

    // 2. ワーカーを起動 (同時処理数3)
    await worker.start(3);

    // 3. 10個のタスクを同時に投入
    const taskCount = 10;
    const taskPromises = Array.from({length: taskCount}, (_, i) => tasks.incrementTask(i).getResult());

    // 4. すべてのタスク結果を待機
    const taskResults = await Promise.all(taskPromises);

    // 5. ワーカーを停止
    await worker.stop();

    // 6. 結果を検証
    expect(taskResults).toHaveLength(taskCount);

    // 各タスクは入力値+1の結果を返すはず
    const results = taskResults.map((result) => {
      expect(result.status).toBe('success');
      return result.status === 'success' ? result.value : -1;
    });

    for (let i = 0; i < taskCount; i++) {
      expect(results).toContain(i + 1);
    }
  });
});
