/**
 * Mitsuba コアクラス
 * 分散タスク処理システムのメインエントリポイント
 */
import {
  type MitsubaOptions,
  type Broker,
  type Backend,
  type TaskRegistry,
  type AsyncTask,
  type TaskOptions,
  type TaskStatus,
  type TaskPayload,
  type CreatedTask,
  type TaskId,
  type TaskResult,
  unwrapResult,
} from './types';
import {AMQPBroker} from './brokers/amqp';
import {AMQPBackend} from './backends/amqp';
import {WorkerPool} from './worker';
import {getLogger} from './logger';
import {generateTaskId} from './utils';

/**
 * Publisher側で使用するAsyncTask実装
 */
class TaskPromiseWrapper<T> implements AsyncTask<T> {
  public readonly taskId: TaskId;
  private readonly backend: Backend;
  private readonly publisher: () => Promise<unknown>;
  private readonly taskExecution: Promise<TaskResult<T>>;
  private _status: TaskStatus = 'PENDING';
  private _result: TaskResult<T> | null = null;

  constructor(taskId: TaskId, backend: Backend, publisher: () => Promise<unknown>) {
    this.taskId = taskId;
    this.backend = backend;
    this.publisher = publisher;

    this.taskExecution = this.startTask();
  }

  /**
   * 結果が利用可能になるまでポーリングする
   * FIXME: どうみてもポーリングしてない
   * @private
   */
  private async startTask(): Promise<TaskResult<T>> {
    this._status = 'STARTED';

    try {
      // consumer first
      const resultConsumer = this.backend.getResult<T>(this.taskId);
      // then publish
      await this.publisher();

      const result = await resultConsumer;
      this._result = result;
      this._status = result.status === 'success' ? 'SUCCESS' : 'FAILURE';
      return result;
    } catch (error) {
      this._status = 'FAILURE';
      return {
        status: 'failure',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  getStatus(): TaskStatus {
    return this._status;
  }

  async getResult(): Promise<TaskResult<T>> {
    if (this._result) {
      return this._result;
    }

    return await this.taskExecution;
  }
  get() {
    return unwrapResult(this.getResult());
  }

  async waitUntilComplete(options?: {pollInterval?: number; timeout?: number}): Promise<TaskResult<T>> {
    const pollInterval = options?.pollInterval || 1000;
    const timeout = options?.timeout || 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const status = await this.getStatus();
      if (status === 'SUCCESS' || status === 'FAILURE') {
        return this.getResult();
      }

      // 指定された間隔で待機
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // タイムアウト時にはエラーを返す
    this._status = 'FAILURE';
    return {
      status: 'failure',
      error: new Error(`Task execution timed out after ${timeout}ms`),
    };
  }

  retry(): AsyncTask<T> {
    this._status = 'RETRY';
    throw new Error('Cannot retry task before it has been published');
  }
}

/**
 * Mitsubaメインクラス
 */
export class Mitsuba {
  private broker: Broker;
  private backend: Backend;
  private workerPool: WorkerPool | null = null;
  private readonly logger = getLogger();
  public readonly name: string;

  /**
   * @param name - アプリケーション名
   * @param options - Mitsubaオプション
   */
  constructor(name: string, options: MitsubaOptions) {
    this.name = name;
    this.broker = this.createBroker(options.broker);
    this.backend = this.createBackend(options.backend);
  }

  /**
   * @param broker - ブローカーURLまたはブローカーインスタンス
   * @returns ブローカーインスタンス
   * @throws サポートされていないプロトコルの場合
   */
  private createBroker(broker: string | Broker): Broker {
    if (typeof broker !== 'string') {
      return broker;
    }

    if (broker.startsWith('amqp://')) {
      return new AMQPBroker(this.name, broker);
    }

    throw new Error(`Unsupported broker protocol: ${broker}`);
  }

  /**
   * @param backend - バックエンドURLまたはバックエンドインスタンス
   * @returns バックエンドインスタンス
   * @throws サポートされていないプロトコルの場合
   */
  private createBackend(backend: string | Backend): Backend {
    if (typeof backend !== 'string') {
      return backend;
    }

    if (backend.startsWith('amqp://')) {
      return new AMQPBackend(backend, this.name);
    }

    throw new Error(`Unsupported backend protocol: ${backend}`);
  }

  /**
   * Mitsubaを初期化
   */
  async init(): Promise<void> {
    await Promise.all([this.broker.connect(), this.backend.connect()]);
    this.logger.info(`Mitsuba initialized: ${this.name}`);
  }

  /**
   * Mitsubaとの接続を閉じる
   */
  async close(): Promise<void> {
    if (this.workerPool) {
      await this.workerPool.stop();
      this.workerPool = null;
    }

    await Promise.all([this.broker.disconnect(), this.backend.disconnect()]);
    this.logger.info(`Mitsuba closed: ${this.name}`);
  }

  /**
   * タスクレジストリからタスク実行関数を作成
   * @param registry - タスクレジストリ
   * @returns タスク実行関数マップとワーカーオブジェクト
   */
  createTask<const T extends TaskRegistry<string, any>>(
    registry: T,
  ): {
    tasks: CreatedTask<T>;
    worker: {
      start: (concurrency?: number) => Promise<void>;
      stop: () => Promise<void>;
    };
  } {
    const tasks = {} as CreatedTask<T>;
    const registeredTaskNames: Array<string> = [];

    for (const [taskName, task] of Object.entries(registry)) {
      registeredTaskNames.push(taskName);
      if (typeof task === 'function') {
        // can't be typesafe
        (tasks as any)[taskName] = (...args: ReadonlyArray<unknown>) => {
          const taskId = generateTaskId();
          return new TaskPromiseWrapper(taskId, this.backend, () => this.broker.publishTask(taskId, taskName, args, undefined));
        };
      } else {
        const taskObj = task as {opts?: TaskOptions; call: (...args: ReadonlyArray<unknown>) => unknown};
        // can't be typesafe
        (tasks as any)[taskName as keyof T] = (...args: ReadonlyArray<unknown>) => {
          const taskId = generateTaskId();
          return new TaskPromiseWrapper(taskId, this.backend, () => this.broker.publishTask(taskId, taskName, args, taskObj.opts));
        };
      }
    }

    const taskHandler = (payload: TaskPayload): Promise<unknown> => {
      const {taskName, args} = payload;
      const taskDef = registry[taskName as keyof T];

      if (!taskDef) {
        throw new Error(`Task not found: ${taskName}`);
      }

      if (typeof taskDef === 'function') {
        return taskDef(...args);
      }

      return taskDef.call(...args);
    };

    return {
      tasks,
      worker: {
        start: async (concurrency = 1): Promise<void> => {
          if (this.workerPool) {
            switch (this.workerPool.getState()) {
              case 'RUNNING':
                return;
              case 'ERROR':
              case 'STOPPED':
              case 'IDLE':
                await this.workerPool.stop().catch(() => ({}));
                this.workerPool = new WorkerPool(this.broker, this.backend, taskHandler);
            }
          } else {
            this.workerPool = new WorkerPool(this.broker, this.backend, taskHandler);
          }
          return await this.workerPool.start(registeredTaskNames, concurrency);
        },

        stop: async (): Promise<void> => {
          if (this.workerPool) {
            await this.workerPool.stop();
            this.workerPool = null;
          }
          return Promise.resolve();
        },
      },
    };
  }
}

/**
 * Mitsubaインスタンスを作成
 * @param name - アプリケーション名
 * @param options - Mitsubaオプション
 * @returns Mitsubaインスタンス
 */
export function mitsuba(name: string, options: MitsubaOptions): Mitsuba {
  return new Mitsuba(name, options);
}

// 必要なタイプのエクスポート
export type {MitsubaOptions, AsyncTask, TaskOptions, TaskStatus, TaskPayload, WorkerPoolState} from './types';
