/**
 * Mitsuba コアクラス
 * 分散タスク処理システムのメインエントリポイント
 */
import type {
  MitsubaOptions,
  BrokerInterface,
  BackendInterface,
  TaskRegistry,
  AsyncTask,
  TaskOptions,
  TaskStatus,
  TaskPayload,
} from './types';
import {AMQPBroker} from './brokers/amqp';
import {AMQPBackend} from './backends/amqp';
import {WorkerPool} from './worker';
import {getLogger} from './logger';

/**
 * Promise ラッパー
 * Publisher側で使用するAsyncTask実装
 */
class TaskPromiseWrapper<T> implements AsyncTask<T> {
  private readonly taskPromise: Promise<string>;
  private readonly backend: BackendInterface;

  constructor(taskIdPromise: Promise<string>, backend: BackendInterface) {
    this.taskPromise = taskIdPromise;
    this.backend = backend;
  }

  get id(): string {
    throw new Error('Cannot access task ID synchronously. Use promise() instead.');
  }

  async promise(): Promise<T> {
    const taskId = await this.taskPromise;
    return this.backend.getResult<T>(taskId);
  }

  async status(): Promise<TaskStatus> {
    const taskId = await this.taskPromise;
    try {
      await this.backend.getResult<T>(taskId);
      return 'SUCCESS';
    } catch {
      return 'PENDING';
    }
  }

  retry(): never {
    throw new Error('Cannot retry task before it has been published');
  }
}

/**
 * Mitsubaメインクラス
 */
export class Mitsuba {
  /** ブローカーインスタンス */
  private broker: BrokerInterface;
  /** バックエンドインスタンス */
  private backend: BackendInterface;
  /** ワーカープール */
  private workerPool: WorkerPool | null = null;
  /** ロガー */
  private readonly logger = getLogger();
  /** アプリケーション名 */
  public readonly name: string;

  /**
   * Mitsubaを初期化
   * @param name - アプリケーション名
   * @param options - Mitsubaオプション
   */
  constructor(name: string, options: MitsubaOptions) {
    this.name = name;
    this.broker = this.createBroker(options.broker);
    this.backend = this.createBackend(options.backend);
  }

  /**
   * ブローカーインスタンスを作成
   * @param broker - ブローカーURLまたはブローカーインスタンス
   * @returns ブローカーインスタンス
   * @throws サポートされていないプロトコルの場合
   */
  private createBroker(broker: string | BrokerInterface): BrokerInterface {
    if (typeof broker !== 'string') {
      return broker;
    }

    if (broker.startsWith('amqp://')) {
      return new AMQPBroker({url: broker});
    }

    throw new Error(`Unsupported broker protocol: ${broker}`);
  }

  /**
   * バックエンドインスタンスを作成
   * @param backend - バックエンドURLまたはバックエンドインスタンス
   * @returns バックエンドインスタンス
   * @throws サポートされていないプロトコルの場合
   */
  private createBackend(backend: string | BackendInterface): BackendInterface {
    if (typeof backend !== 'string') {
      return backend;
    }

    if (backend.startsWith('amqp://')) {
      return new AMQPBackend(backend);
    }

    throw new Error(`Unsupported backend protocol: ${backend}`);
  }

  /**
   * Mitsubaを初期化
   */
  async init(): Promise<void> {
    await this.broker.connect();
    await this.backend.connect();
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

    await this.broker.disconnect();
    await this.backend.disconnect();
    this.logger.info(`Mitsuba closed: ${this.name}`);
  }

  /**
   * タスクレジストリからタスク実行関数を作成
   * @param registry - タスクレジストリ
   * @returns タスク実行関数マップとワーカーオブジェクト
   */
  createTask<T extends TaskRegistry<T>>(
    registry: T,
  ): {
    tasks: {[K in keyof T]: (...args: Array<unknown>) => AsyncTask<unknown>};
    worker: {
      start: (concurrency?: number) => Promise<void>;
    };
  } {
    const tasks = {} as {[K in keyof T]: (...args: Array<unknown>) => AsyncTask<unknown>};
    const registeredTaskNames: Array<string> = [];

    for (const [taskName, task] of Object.entries(registry)) {
      registeredTaskNames.push(taskName);
      if (typeof task === 'function') {
        tasks[taskName as keyof T] = (...args: Array<unknown>): AsyncTask<unknown> => {
          const taskId = this.broker.publishTask(taskName, args, undefined);
          return new TaskPromiseWrapper(taskId, this.backend);
        };
      } else {
        // タスクがオブジェクトの場合
        const taskObj = task as {opts?: TaskOptions; call: (...args: Array<unknown>) => unknown};
        tasks[taskName as keyof T] = (...args: Array<unknown>): AsyncTask<unknown> => {
          const taskId = this.broker.publishTask(taskName, args, taskObj.opts);
          return new TaskPromiseWrapper(taskId, this.backend);
        };
      }
    }

    // タスクハンドラー関数を作成
    const taskHandler = async (payload: TaskPayload): Promise<unknown> => {
      const {taskName, args} = payload;
      const taskDef = registry[taskName as keyof T];

      if (!taskDef) {
        throw new Error(`Task not found: ${taskName}`);
      }

      if (typeof taskDef === 'function') {
        return await Promise.resolve(taskDef(...args));
      }

      return await Promise.resolve(taskDef.call(...args));
    };

    // ワーカーオブジェクトを作成
    const worker = {
      start: async (concurrency = 1): Promise<void> => {
        // 既存のworkerPoolを使用するか、新しく作成する
        if (!this.workerPool) {
          this.workerPool = new WorkerPool(this.broker, this.backend, taskHandler);
        }
        return await this.workerPool.start(registeredTaskNames, concurrency);
      },
    };

    return {tasks, worker};
  }

  /**
   * ワーカープールを開始
   * @param taskNames - 処理対象のタスク名配列
   * @param concurrency - 並行処理数
   */
  async startWorker(taskNames: ReadonlyArray<string> = [], concurrency = 1): Promise<void> {
    // ワーカープールがなければ作成
    if (!this.workerPool) {
      // 実際の実装はここで拡張する
      this.logger.info(`Starting worker: ${this.name} with concurrency ${concurrency}`);

      // タスク名がなければログ出力
      if (taskNames.length === 0) {
        this.logger.warn('No task names provided, worker will not consume any messages');
      }

      // 実際のワーカープール実装を作成するコードをここに追加
      await Promise.resolve(); // 非同期処理の一例
    }
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
