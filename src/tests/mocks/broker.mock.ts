/**
 * ブローカーのモック実装
 */
import {v4 as uuidv4} from 'uuid';
import type {BrokerInterface, TaskPayload, TaskOptions} from '../../types';

type TaskHandler = (task: unknown) => Promise<unknown>;

export class MockBroker implements BrokerInterface {
  private tasks = new Map<string, TaskPayload>();
  private handlers = new Map<string, TaskHandler>();
  private consumerTags = new Map<string, string>();
  private connected = false;
  private shouldFailPublish = false;

  async connect(): Promise<void> {
    await Promise.resolve();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await Promise.resolve();
    this.connected = false;
    this.handlers.clear();
    this.consumerTags.clear();
  }

  async publishTask(taskName: string, args: ReadonlyArray<unknown>, options?: TaskOptions): Promise<string> {
    await Promise.resolve();

    if (!this.connected) {
      throw new Error('Broker is not connected');
    }

    if (this.shouldFailPublish) {
      throw new Error('Failed to publish task');
    }

    const taskId = uuidv4();
    const payload: TaskPayload = {
      id: taskId,
      taskName,
      args,
      options,
    };

    this.tasks.set(taskId, payload);

    // 即時実行: タスクハンドラが登録されていれば直ちに実行する
    const handler = this.handlers.get(taskName);
    if (handler) {
      setTimeout(() => {
        handler(payload).catch(console.error);
      }, 0);
    }

    return taskId;
  }

  async consumeTask(queueName: string, handler: TaskHandler): Promise<string> {
    await Promise.resolve();

    if (!this.connected) {
      throw new Error('Broker is not connected');
    }

    const consumerTag = uuidv4();
    this.handlers.set(queueName, handler);
    this.consumerTags.set(consumerTag, queueName);
    return consumerTag;
  }

  async cancelConsumer(consumerTag: string): Promise<void> {
    await Promise.resolve();

    if (!this.connected) {
      throw new Error('Broker is not connected');
    }

    const queueName = this.consumerTags.get(consumerTag);
    if (queueName) {
      this.handlers.delete(queueName);
      this.consumerTags.delete(consumerTag);
    }
  }

  // モックテスト用のヘルパーメソッド
  getTaskById(taskId: string): TaskPayload | undefined {
    return this.tasks.get(taskId);
  }

  clearTasks(): void {
    this.tasks.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // テスト用：パブリッシュ失敗をシミュレートするための設定
  setShouldFailPublish(shouldFail: boolean): void {
    this.shouldFailPublish = shouldFail;
  }
}
