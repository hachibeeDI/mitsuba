/**
 * バックエンドのモック実装
 */
import type {BackendInterface} from '../../types';
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

  async connect(): Promise<void> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    // Wait a tick to simulate async behavior
    await Promise.resolve();
    this.connected = false;
    this.results.clear();
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
