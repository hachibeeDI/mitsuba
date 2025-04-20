/**
 * バックエンドのモック実装
 */
import {EventEmitter} from 'node:events';
import type {Backend, TaskId} from '../../types';
import {TaskRetrievalError} from '../../errors';

interface StoredResult {
  result: unknown;
  expireAt?: number;
}

export class MockBackend implements Backend {
  private results = new Map<TaskId, StoredResult>();
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

    // タスク処理結果をリッスン
    this.messageQueue.on('taskResult', (data: {taskId: TaskId; result: unknown}) => {
      if (data?.taskId) {
        this.setResult(data.taskId, data.result);
      }
    });

    // タスク実行結果をリッスン
    this.messageQueue.on('taskExecuted', (data: {taskId: TaskId; status: string; result?: unknown; error?: unknown}) => {
      if (data?.taskId && data.status === 'SUCCESS' && data.result !== undefined) {
        this.setResult(data.taskId, data.result);
      }
    });
  }

  async disconnect(): Promise<void> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();
    this.connected = false;
    this.results.clear();

    // イベントリスナーを削除
    this.messageQueue.removeAllListeners('taskResult');
    this.messageQueue.removeAllListeners('taskExecuted');
  }

  async storeResult(taskId: TaskId, result: unknown, ttl?: number): Promise<void> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();

    if (!this.connected) {
      throw new Error('Backend is not connected');
    }

    if (this.shouldFailStore) {
      throw new Error('Failed to store result');
    }

    const stored: StoredResult = {
      result,
    };

    if (ttl) {
      stored.expireAt = Date.now() + ttl * 1000;
    }

    this.results.set(taskId, stored);

    // 結果をメッセージキューに発行
    this.messageQueue.emit('taskResult', {taskId, result});
  }

  async getResult<T>(taskId: TaskId, timeout = 5000): Promise<T> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();

    if (!this.connected) {
      throw new Error('Backend is not connected');
    }

    if (this.shouldFailRetrieve) {
      throw new TaskRetrievalError(taskId);
    }

    // Check if result is already available
    const checkResult = (): StoredResult | undefined => {
      const storedResult = this.results.get(taskId);

      // TTLが設定されていて期限切れの場合はnullを返す
      if (storedResult?.expireAt && storedResult.expireAt < Date.now()) {
        this.results.delete(taskId);
        return undefined;
      }

      return storedResult;
    };

    // Initial check
    const initialResult = checkResult();
    if (initialResult) {
      return initialResult.result as T;
    }

    // Wait for result if not immediately available
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new TaskRetrievalError(taskId));
      }, timeout);

      const handleTaskResult = (data: {taskId: TaskId; result: unknown}) => {
        if (data.taskId === taskId) {
          const result = checkResult();
          if (result) {
            cleanup();
            resolve(result.result as T);
          }
        }
      };

      const handleTaskExecuted = (data: {taskId: TaskId; status: string; result?: unknown}) => {
        if (data.taskId === taskId && data.status === 'SUCCESS') {
          const result = checkResult();
          if (result) {
            cleanup();
            resolve(result.result as T);
          }
        }
      };

      const cleanup = () => {
        if (this.results.has(taskId)) {
          this.results.delete(taskId);
        }
        clearTimeout(timeoutId);
        this.messageQueue.removeListener('taskResult', handleTaskResult);
        this.messageQueue.removeListener('taskExecuted', handleTaskExecuted);
      };

      this.messageQueue.on('taskResult', handleTaskResult);
      this.messageQueue.on('taskExecuted', handleTaskExecuted);
    });
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

  // 特定のタスクの結果を直接設定（テスト用）
  setResult(taskId: TaskId, result: unknown, expiresIn = 3600): void {
    const expires = Date.now() + expiresIn * 1000;
    this.results.set(taskId, {
      result,
      expireAt: expires,
    });
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
