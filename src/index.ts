/**
 * Mitsuba メインエントリーポイント
 * 分散タスク処理システムのエントリーポイント
 */
import type {
  MitsubaOptions,
  BrokerInterface,
  BackendInterface,
  TaskRegistry,
  AsyncTask,
  TaskOptions,
  TaskStatus,
} from './types';
import {AMQPBroker} from './brokers/amqp';
import {AMQPBackend} from './backends/amqp';
import type {WorkerPool} from './worker';
import {getLogger} from './logger';

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
  constructor(
    name: string,
    options: MitsubaOptions,
  ) {
    this.name = name;
    this.broker = this.createBroker(options.broker);
    this.backend = this.createBackend(options.backend);
  }

  /**
   * ブローカーインスタンスを作成
   * @param brokerUrl - ブローカーURL
   * @returns ブローカーインスタンス
   * @throws サポートされていないプロトコルの場合
   */
  private createBroker(brokerUrl: string): BrokerInterface {
    if (brokerUrl.startsWith('amqp://')) {
      return new AMQPBroker({url: brokerUrl});
    }
    throw new Error(`Unsupported broker protocol: ${brokerUrl}`);
  }

  /**
   * バックエンドインスタンスを作成
   * @param backendUrl - バックエンドURL
   * @returns バックエンドインスタンス
   * @throws サポートされていないプロトコルの場合
   */
  private createBackend(backendUrl: string): BackendInterface {
    if (backendUrl.startsWith('amqp://')) {
      return new AMQPBackend(backendUrl);
    }
    throw new Error(`Unsupported backend protocol: ${backendUrl}`);
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
   * @returns タスク実行関数マップ
   */
  createTask<T extends TaskRegistry<T>>(registry: T): {[K in keyof T]: (...args: Array<unknown>) => AsyncTask<unknown>} {
    const result = {} as {[K in keyof T]: (...args: Array<unknown>) => AsyncTask<unknown>};

    for (const [taskName, task] of Object.entries(registry)) {
      if (typeof task === 'function') {
        result[taskName as keyof T] = (...args: Array<unknown>): AsyncTask<unknown> => {
          const taskId = this.broker.publishTask(taskName, args, undefined);
          return new TaskPromiseWrapper(taskId, this.backend);
        };
      } else {
        // タスクがオブジェクトの場合
        const taskObj = task as {opts?: TaskOptions; call: (...args: Array<unknown>) => unknown};
        result[taskName as keyof T] = (...args: Array<unknown>): AsyncTask<unknown> => {
          const taskId = this.broker.publishTask(taskName, args, taskObj.opts);
          return new TaskPromiseWrapper(taskId, this.backend);
        };
      }
    }

    return result;
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
 * Promise ラッパー
 * Publisher側で使用するAsyncTask実装
 */
class TaskPromiseWrapper<T> implements AsyncTask<T> {
  private readonly taskPromise: Promise<string>;
  private readonly backend: BackendInterface;

  constructor(
    taskIdPromise: Promise<string>,
    backend: BackendInterface,
  ) {
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
 * Mitsubaインスタンスを作成
 * @param name - アプリケーション名
 * @param options - Mitsubaオプション
 * @returns Mitsubaインスタンス
 */
export function mitsuba(name: string, options: MitsubaOptions): Mitsuba {
  return new Mitsuba(name, options);
}

// 必要なタイプのエクスポート
export type {MitsubaOptions, AsyncTask, TaskOptions, TaskStatus} from './types';
