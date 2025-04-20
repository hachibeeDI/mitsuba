/**
 * Mitsuba ワーカープール実装
 */
import type {BrokerInterface, BackendInterface, TaskPayload} from './types';
import {WorkerPoolState} from './types';
import {WorkerOperationError} from './errors';
import {getLogger} from './logger';

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
 */
export class WorkerPool {
  private workers: Array<Promise<void>> = [];
  private consumerTags = new Map<string, string>();
  private state: WorkerPoolState = WorkerPoolState.IDLE;
  private activeTaskCount = 0;
  private readonly stopTimeoutMs: number;
  private readonly logger = getLogger();

  constructor(
    private readonly broker: BrokerInterface,
    private readonly backend: BackendInterface,
    private readonly taskHandlerFn: (task: TaskPayload) => Promise<unknown>,
    options: WorkerPoolOptions = {},
  ) {
    this.stopTimeoutMs = options.gracefulShutdownTimeout ?? 30000;
  }

  async start(taskNames: ReadonlyArray<string>, concurrency = 1): Promise<void> {
    if (this.state === WorkerPoolState.RUNNING || this.state === WorkerPoolState.STOPPING) {
      throw new WorkerOperationError(`Cannot start worker pool in ${this.state} state`);
    }

    if (taskNames.length === 0) {
      this.logger.warn('No tasks registered, worker will not consume any messages');
      return;
    }

    this.state = WorkerPoolState.RUNNING;

    const workerPromises = taskNames.flatMap((taskName) =>
      Array.from({length: concurrency}, async (_, index) => {
        const workerId = `${taskName}-${index}`;
        this.logger.info(`Starting worker ${workerId}`);

        try {
          const consumerTag = await this.broker.consumeTask(taskName, async (payload) => {
            if (!this.isValidTaskPayload(payload)) {
              this.logger.error(`Invalid task payload received for ${taskName}`, payload);
              return;
            }

            this.activeTaskCount++;

            try {
              this.logger.debug(`Processing task ${(payload as TaskPayload).id}`);
              const result = await this.taskHandlerFn(payload as TaskPayload);

              const taskId = (payload as TaskPayload).id;
              const options = (payload as TaskPayload).options;
              await this.backend.storeResult(taskId, result, options?.resultExpires);

              this.logger.debug(`Task ${taskId} completed successfully`);
            } catch (error) {
              this.logger.error('Error processing task:', error);
              throw error;
            } finally {
              this.activeTaskCount--;
            }
          });

          this.consumerTags.set(workerId, consumerTag);

          while (this.state === WorkerPoolState.RUNNING) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          this.logger.info(`Worker ${workerId} shutting down`);
        } catch (error) {
          this.logger.error(`Worker ${workerId} failed:`, error);
          throw error;
        }
      }),
    );

    this.workers = workerPromises;
    this.logger.info(`Started ${concurrency} worker(s) for ${taskNames.length} task type(s)`);

    try {
      await Promise.all(this.workers);
    } catch (error) {
      this.logger.error('Error in worker pool:', error);
      this.state = WorkerPoolState.ERROR;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === WorkerPoolState.STOPPED) {
      return;
    }

    this.state = WorkerPoolState.STOPPING;
    this.logger.info('Stopping worker pool');

    try {
      await this.cancelAllConsumers();
      await this.waitForWorkerCompletion();
      await this.closeAllConnections();

      this.resetPool();
      this.state = WorkerPoolState.STOPPED;
      this.logger.info('Worker pool stopped successfully');
    } catch (error) {
      this.state = WorkerPoolState.ERROR;
      this.logger.error('Failed to stop worker pool', error);
      throw error;
    }
  }

  getActiveTaskCount(): number {
    return this.activeTaskCount;
  }

  getState(): WorkerPoolState {
    return this.state;
  }

  private async cancelAllConsumers(): Promise<void> {
    if (this.consumerTags.size === 0) {
      this.logger.info('No consumers to cancel');
      return;
    }

    this.logger.info(`Cancelling ${this.consumerTags.size} consumers`);

    const results = await Promise.allSettled(
      Array.from(this.consumerTags.entries()).map(([workerId, tag]) => {
        return this.cancelSingleConsumer(tag).then(
          () => this.logger.info(`Successfully cancelled consumer ${workerId}`),
          (reason) => this.logger.warn(`Failed to cancel consumer ${workerId}: ${reason}`),
        );
      }),
    );

    const failedCount = results.filter((r) => r.status === 'rejected').length;
    if (failedCount > 0) {
      this.logger.warn(`${failedCount} consumers failed to cancel properly`);
    }
  }

  private async cancelSingleConsumer(tag: string): Promise<boolean> {
    await this.broker.cancelConsumer(tag);
    return true;
  }

  private async waitForWorkerCompletion(): Promise<void> {
    if (this.activeTaskCount === 0) {
      this.logger.info('No active tasks to wait for');
      return;
    }

    this.logger.info(`Waiting for ${this.activeTaskCount} active tasks to complete`);

    const timeout = this.stopTimeoutMs;
    let remaining = timeout;
    const checkInterval = 1000;
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

  private async closeAllConnections(): Promise<void> {
    try {
      this.logger.info('Disconnecting backend');
      await this.backend.disconnect();
      this.logger.info('Backend disconnected');
    } catch (error) {
      this.logger.error('Error disconnecting backend', error);
    }

    try {
      this.logger.info('Disconnecting broker');
      await this.broker.disconnect();
      this.logger.info('Broker disconnected');
    } catch (error) {
      this.logger.error('Error disconnecting broker', error);
    }
  }

  private resetPool(): void {
    this.workers = [];
    this.consumerTags.clear();
    this.activeTaskCount = 0;
  }

  private isValidTaskPayload(payload: unknown): payload is TaskPayload {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const p = payload as Record<string, unknown>;

    if (typeof p.id !== 'string' || !p.id) {
      return false;
    }

    if (typeof p.taskName !== 'string' || !p.taskName) {
      return false;
    }

    if (!Array.isArray(p.args)) {
      return false;
    }

    if (p.options !== undefined && (typeof p.options !== 'object' || p.options === null)) {
      return false;
    }

    return true;
  }
}
