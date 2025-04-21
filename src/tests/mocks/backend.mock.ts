/**
 * バックエンドのモック実装
 */
import {EventEmitter} from 'node:events';
import type {Backend, TaskId, TaskResult} from '../../types';
import {TaskRetrievalError, TaskTimeoutError} from '../../errors';
import {pooling} from '../../helpers';

type StoredResult<T> = TaskResult<T> & {expiresAt?: number};

export class MockBackend implements Backend {
  private results = new Map<TaskId, StoredResult<unknown>>();
  private connected = false;
  private shouldFailStore = false;
  private shouldFailRetrieve = false;
  private messageQueue: EventEmitter;

  constructor(messageQueue?: EventEmitter) {
    this.messageQueue = messageQueue || new EventEmitter();
    // Set max listeners to avoid memory leak warnings
    this.messageQueue.setMaxListeners(100);
  }

  getMessageQueue(): EventEmitter {
    return this.messageQueue;
  }

  async connect(): Promise<void> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();
    this.connected = true;

    this.messageQueue.on('taskResult', (data: {taskId: TaskId; result: StoredResult<unknown>}) => {
      this.results.set(data.taskId, data.result);
    });
  }

  async disconnect(): Promise<void> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();
    this.connected = false;
    this.results.clear();

    // イベントリスナーを削除
    this.messageQueue.removeAllListeners('taskResult');
  }

  async storeResult(taskId: TaskId, result: TaskResult<unknown>, expiresIn?: number): Promise<void> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();

    if (!this.connected) {
      throw new Error('Backend is not connected');
    }

    if (this.shouldFailStore) {
      throw new Error('Failed to store result');
    }

    console.log('store result', result);
    const toStore: StoredResult<unknown> = expiresIn ? {...result, expiresAt: Date.now() + expiresIn * 1000} : result;

    this.results.set(taskId, toStore);
    this.messageQueue.emit('taskResult', {taskId, result});
  }

  async getResult<T>(taskId: TaskId, timeout = 5000): Promise<TaskResult<T>> {
    if (!this.connected) {
      return {
        status: 'failure',
        error: new Error('Backend is not connected'),
      };
    }

    if (this.shouldFailRetrieve) {
      return {
        status: 'failure',
        error: new TaskRetrievalError(taskId),
      };
    }

    const checkResult = (): StoredResult<T> | undefined => {
      const storedResult = this.results.get(taskId);

      // TTLが設定されていて期限切れの場合はnullを返す
      if (storedResult?.expiresAt && storedResult.expiresAt < Date.now()) {
        this.results.delete(taskId);
        return undefined;
      }

      return storedResult as StoredResult<T>;
    };

    const initialResult = checkResult();
    if (initialResult) {
      console.log('initial check passed', initialResult);
      return initialResult as TaskResult<T>;
    }

    const interval = Math.max(1, timeout / 50);
    return pooling(
      () => {
        const r = checkResult();
        if (r == null) {
          return {continue: true};
        }
        return {continue: false, v: r};
      },
      {interval, maxRetry: Math.min(timeout, 50)},
    ).catch((_err) => ({status: 'failure', error: new TaskTimeoutError(taskId, timeout)}));
  }

  // モックテスト用のヘルパーメソッド
  hasResult(taskId: TaskId): boolean {
    return this.results.has(taskId);
  }

  clearResults(): void {
    this.results.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // テスト用：結果保存の失敗をシミュレートするための設定
  setShouldFailStore(shouldFail: boolean): void {
    this.shouldFailStore = shouldFail;
  }

  // テスト用：結果取得の失敗をシミュレートするための設定
  setShouldFailRetrieve(shouldFail: boolean): void {
    this.shouldFailRetrieve = shouldFail;
  }
}
