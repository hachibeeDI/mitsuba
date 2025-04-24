/**
 * Mitsuba ワーカープール実装
 */
import type {Broker, Backend, TaskPayload} from './types';
import {WorkerPoolState} from './types';
import {WorkerOperationError} from './errors';
import {getLogger} from './logger';
import {Queue} from './queue';

/**
 * ワーカープール設定オプション
 */
export type WorkerPoolOptions = {
  /** シャットダウン時のタイムアウト（ミリ秒） */
  gracefulShutdownTimeout?: number;
  /** ワーカーの最大同時実行数 */
  maxConcurrency?: number;
  /** ワーカーの最小実行数 */
  minWorkers?: number;
};

/**
 * ワーカープール
 * タスクの受信・キューイング・実行を管理するクラス
 * 非同期ノンブロッキングアーキテクチャを使用し、効率的な並行処理を実現
 */
export class WorkerPool {
  /** ワーカーの非同期実行を表すPromise配列 */
  private workerPromises: Array<Promise<void>> = [];

  /**
   * タスク名とそのコンシューマーの対応マップ
   * キー: ワーカーID、値: ブローカーから返されたコンシューマータグ
   * (コンシューマータグはリスナーの登録解除に必須)
   */
  private consumerTags: ReadonlySet<string> = new Set<string>();

  /** 現在の実行状態 */
  private state: WorkerPoolState = WorkerPoolState.IDLE;

  /** 現在処理中のタスク数 */
  private activeTaskCount = 0;

  /** シャットダウン時のタイムアウト（ミリ秒） */
  private readonly stopTimeoutMs: number;

  private readonly logger = getLogger();
  private readonly broker: Broker;
  private readonly backend: Backend;
  private readonly taskHandlerFn: (task: TaskPayload) => Promise<unknown>;

  /** ワーカーの停止制御用 */
  private abortController: AbortController | null = null;

  /**
   * 処理待ちのタスクキュー
   * ブローカーから受信したタスクはこのキューに追加され、
   * ワーカーマネージャーによって順次処理される
   */
  private taskQueue: Queue<{taskName: string; payload: TaskPayload}> = new Queue();

  /**
   * 現在処理中のタスクのIDセット
   * タスクの重複処理を避け、並行処理数を管理するために使用
   */
  private processingTasks = new Set<string>();

  constructor(broker: Broker, backend: Backend, taskHandlerFn: (task: TaskPayload) => Promise<unknown>, options: WorkerPoolOptions = {}) {
    this.broker = broker;
    this.backend = backend;
    this.taskHandlerFn = taskHandlerFn;
    this.stopTimeoutMs = options.gracefulShutdownTimeout ?? 30000;
  }

  /**
   * ワーカープールを開始
   * 指定されたタスク名に対してコンシューマーを設定し、タスク処理マネージャーを起動する
   * 非同期ノンブロッキングで動作するため、即時制御を返す
   *
   * @param taskNames - 処理するタスク名の配列
   * @param concurrency - 各タスク名ごとの並行処理数 --- AIは何度教えてもNodeの並列APIを理解できないみたいなので現在は未対応
   */
  async start(taskNames: ReadonlyArray<string>, concurrency = 1): Promise<void> {
    if (this.state === WorkerPoolState.RUNNING || this.state === WorkerPoolState.STOPPING) {
      throw new WorkerOperationError(`Cannot start worker pool in ${this.state} state`);
    }
    if (taskNames.length === 0) {
      this.logger.warn('No tasks registered, worker will not consume any messages');
      return;
    }

    this.state = WorkerPoolState.RUNNING;
    this.abortController = new AbortController();

    this.consumerTags = new Set(await Promise.all(taskNames.map((t) => this.setupTaskConsumer(t))));

    const workerManager = this.startWorkerManager(this.abortController.signal);
    // FIXME:
    this.workerPromises.push(workerManager);

    this.logger.info(`Started worker pool for ${taskNames.length} task type(s) with concurrency ${concurrency}`);

    // 起動が完了したら即座に制御を戻す
    return Promise.resolve();
  }

  /**
   * タスクコンシューマーをセットアップ
   * 特定のタスク名に対するリスナーを登録し、consumerTagsマップに保存する
   */
  private async setupTaskConsumer(taskName: string): Promise<string> {
    const workerId = `worker-${taskName}-${Date.now()}`;

    try {
      const tag = await this.broker.consumeTask(taskName, (payload) => {
        this.taskQueue.enqueue({
          taskName,
          payload,
        });

        return Promise.resolve({
          status: 'accepted',
          taskId: payload.id,
        });
      });
      this.logger.debug(`Registered consumer for ${taskName} with ID ${workerId} (tag: ${tag})`);
      return tag;
    } catch (error) {
      this.logger.error(`Failed to setup consumer for ${taskName}:`, error);
      throw error;
    }
  }

  /**
   * ワーカータスク実行マネージャーを開始
   * キューに追加されたタスクを継続的に処理するループを非同期で実行
   * AbortSignalによって停止可能
   *
   * @param maxConcurrentTasks - 同時に実行可能な最大タスク数
   * @param signal - 停止を伝えるためのAbortSignal
   * @returns 完了を示すPromise
   */
  private async startWorkerManager(signal: AbortSignal): Promise<void> {
    this.taskQueue.listen((queue) => {
      this.logger.debug('Enqueue detected');
      let task: {taskName: string; payload: TaskPayload} | undefined;
      do {
        task = queue.dequeue();
        if (task != null) {
          this.logger.debug(`Start Processing task ${JSON.stringify(task)}`);
          void this.processTask(task.taskName, task.payload);
        }
      } while (task);
    }, signal);
  }

  /**
   * 単一タスクを処理
   * タスクを実行し、結果をバックエンドに保存する
   * 処理状態は activeTaskCount と processingTasks で追跡
   *
   * @param taskName - タスク名
   * @param payload - タスクペイロード
   */
  private async processTask(taskName: string, payload: TaskPayload) {
    const taskId = payload.id;

    // タスク処理中にマーク
    this.activeTaskCount++;
    this.processingTasks.add(taskId);

    this.logger.debug(`Processing task ${taskId} of type ${taskName}`);
    try {
      // タスク実行
      const r = await this.taskHandlerFn(payload);

      this.logger.debug(`Task ${taskName} ${taskId} completed successfully with result=${JSON.stringify(r)}`);
      this.backend.storeResult(payload.id, {status: 'success', value: r}, payload.options?.expires);
    } catch (err) {
      this.logger.error(`Task ${taskId} failed:`, err);

      this.backend.storeResult(
        payload.id,
        {status: 'failure', error: err instanceof Error ? err : new Error(String(err))},
        payload.options?.expires,
      );
    } finally {
      // タスク完了
      this.activeTaskCount--;
      this.processingTasks.delete(taskId);
    }
  }

  /**
   * ワーカープールを停止
   * 1. AbortControllerで停止信号を送信
   * 2. 処理中のタスクが完了するまで待機
   * 3. すべてのコンシューマーを解除
   */
  async stop(): Promise<void> {
    if (this.state === WorkerPoolState.STOPPED) {
      return;
    }

    this.state = WorkerPoolState.STOPPING;
    this.logger.info('Stopping worker pool');

    try {
      // AbortControllerで停止信号を送信
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }

      // 現在のタスクを処理完了まで待機
      await this.waitForWorkerCompletion();

      // コンシューマーをキャンセル
      await this.cancelAllConsumers();

      this.resetPool();
      this.state = WorkerPoolState.STOPPED;
      this.logger.info('Worker pool stopped successfully');
    } catch (error) {
      this.state = WorkerPoolState.ERROR;
      this.logger.error('Failed to stop worker pool', error);
      throw error;
    }
  }

  /**
   * アクティブなタスク数を取得
   */
  getActiveTaskCount(): number {
    return this.activeTaskCount;
  }

  /**
   * ワーカープールの状態を取得
   */
  getState(): WorkerPoolState {
    return this.state;
  }

  /** */
  private async cancelAllConsumers(): Promise<void> {
    if (this.consumerTags.size === 0) {
      this.logger.info('No consumers to cancel');
      return;
    }

    this.logger.info(`Cancelling ${this.consumerTags.size} consumers`);

    const results = await Promise.allSettled(
      Array.from(this.consumerTags.values()).map((tag) =>
        this.broker
          .cancelConsumer(tag)
          // FIXME: looks AI generated garbage
          .catch(() => this.logger.error(`Failed to cancel consumer ${tag}`)),
      ),
    );

    const failedCount = results.filter((r) => r.status === 'rejected').length;
    if (failedCount > 0) {
      this.logger.warn(`${failedCount} consumers failed to cancel properly`);
    }
  }

  /**
   * ワーカー完了まで待機
   * activeTaskCountが0になるか、タイムアウトするまで待機する
   * 停止処理の一環として使用され、進行中のタスクが完了するのを待つ
   */
  private async waitForWorkerCompletion(): Promise<void> {
    if (this.activeTaskCount === 0) {
      this.logger.info('No active tasks to wait for');
      return;
    }

    this.logger.info(`Waiting for ${this.activeTaskCount} active tasks to complete`);

    const timeout = this.stopTimeoutMs;
    let remaining = timeout;
    const checkInterval = 100;
    const start = Date.now();

    while (this.activeTaskCount > 0 && remaining > 0) {
      this.logger.info(`Waiting for ${this.activeTaskCount} active tasks to complete, ${remaining}ms remaining`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(checkInterval, remaining)));
      remaining = timeout - (Date.now() - start);
    }

    if (this.activeTaskCount > 0) {
      this.logger.warn(`Shutdown timeout reached with ${this.activeTaskCount} tasks still active`);
    } else {
      this.logger.info('All workers completed their tasks');
    }
  }

  /**
   * プールをリセット
   * ワーカープールの内部状態をクリアし、初期状態に戻す
   * 停止処理の最終ステップとして使用
   */
  private resetPool(): void {
    this.workerPromises = [];
    this.consumerTags = new Set();
    this.activeTaskCount = 0;
    this.taskQueue = new Queue();
    this.processingTasks.clear();
  }
}
