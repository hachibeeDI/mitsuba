/**
 * ブローカーのモック実装
 */
import {v4 as uuidv4} from 'uuid';
import {EventEmitter} from 'node:events';
import type {Broker, TaskPayload, TaskOptions, TaskId, TaskHandlerResult} from '../../types';

// 型安全なハンドラー定義
type TaskHandler = (task: TaskPayload) => Promise<TaskHandlerResult>;

export class MockBroker implements Broker {
  private tasks = new Map<TaskId, TaskPayload>();
  private handlers = new Map<string, TaskHandler>();
  private consumerTags = new Map<string, string>();
  private connected = false;
  private shouldFailPublish = false;
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
    await Promise.resolve();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await Promise.resolve();
    this.connected = false;
    this.handlers.clear();
    this.consumerTags.clear();
    this.messageQueue.removeAllListeners('task');
  }

  async publishTask(taskId: TaskId, taskName: string, args: ReadonlyArray<unknown>, options?: TaskOptions): Promise<TaskId> {
    await Promise.resolve();

    if (!this.connected) {
      throw new Error('Broker is not connected');
    }

    if (this.shouldFailPublish) {
      throw new Error('Failed to publish task');
    }

    const payload: TaskPayload = {
      id: taskId,
      taskName,
      args,
      options,
    };

    this.tasks.set(taskId, payload);

    // タスクをメッセージキューに発行
    this.messageQueue.emit('task', payload);

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

    // メッセージキューからタスクを受信
    this.messageQueue.on('task', async (payload: TaskPayload) => {
      if (payload.taskName === queueName) {
        try {
          // タスク実行
          const handlerResult = await handler(payload);

          // ハンドラー結果に基づいて適切なイベントを発行
          if (handlerResult.status === 'processed') {
            // 処理成功イベント - 結果ありの場合
            this.messageQueue.emit('taskExecuted', {
              taskId: handlerResult.taskId,
              taskName: payload.taskName,
              status: 'SUCCESS',
              result: handlerResult.result,
            });
          } else if (handlerResult.status === 'accepted') {
            // タスク受付イベント - キューイングのみ
            this.messageQueue.emit('taskAccepted', {
              taskId: handlerResult.taskId,
              taskName: payload.taskName,
            });
          } else if (handlerResult.status === 'rejected') {
            // タスク拒否イベント
            this.messageQueue.emit('taskRejected', {
              taskId: handlerResult.taskId,
              taskName: payload.taskName,
              reason: handlerResult.reason,
            });
          }
        } catch (error) {
          // 処理失敗イベントを発行
          this.messageQueue.emit('taskExecuted', {
            taskId: payload.id,
            taskName: payload.taskName,
            status: 'FAILURE',
            error,
          });
        }
      }
    });

    return consumerTag;
  }

  async cancelConsumer(consumerTag: string): Promise<void> {
    await Promise.resolve();

    const queueName = this.consumerTags.get(consumerTag);
    if (queueName) {
      this.handlers.delete(queueName);
      this.consumerTags.delete(consumerTag);

      this.messageQueue.removeAllListeners('task');
    }
  }

  // モックテスト用のヘルパーメソッド
  getTaskById(taskId: TaskId): TaskPayload | undefined {
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
