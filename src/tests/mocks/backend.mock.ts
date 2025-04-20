/**
 * バックエンドのモック実装
 */
import {EventEmitter} from 'node:events';
import type {BackendInterface, TaskPayload} from '../../types';
import {TaskRetrievalError} from '../../errors';

interface StoredResult {
  result: unknown;
  expireAt?: number;
}

export class MockBackend implements BackendInterface {
  private results = new Map<string, StoredResult>();
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
    this.messageQueue.on('taskResult', (data: {taskId: string; result: unknown}) => {
      if (data?.taskId) {
        this.setResult(data.taskId, data.result);
      }
    });

    // タスク実行結果をリッスン
    this.messageQueue.on('taskExecuted', (data: {taskId: string; status: string; result?: unknown; error?: unknown}) => {
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

  async storeResult(taskId: string, result: unknown, ttl?: number): Promise<void> {
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

  async getResult<T>(taskId: string): Promise<T> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();

    if (!this.connected) {
      throw new Error('Backend is not connected');
    }

    if (this.shouldFailRetrieve) {
      throw new TaskRetrievalError(taskId);
    }

    const storedResult = this.results.get(taskId);
    if (!storedResult) {
      throw new TaskRetrievalError(taskId);
    }

    // TTLが設定されていて期限切れの場合はnullを返す
    if (storedResult.expireAt && storedResult.expireAt < Date.now()) {
      this.results.delete(taskId);
      throw new TaskRetrievalError(taskId);
    }

    return storedResult.result as T;
  }

  // モックテスト用のヘルパーメソッド
  hasResult(taskId: string): boolean {
    return this.results.has(taskId);
  }

  clearResults(): void {
    this.results.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // 特定のタスクの結果を直接設定（テスト用）
  setResult(taskId: string, result: unknown, expiresIn = 3600): void {
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
