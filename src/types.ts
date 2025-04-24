/** */

import type {LogLevel} from './logger';

export type Branded<T, Brand> = T & {readonly __brand: Brand};

/** No options works so far. */
export type TaskOptions = {
  /** */
  priority?: number;
  /** */
  autoretryFor?: ReadonlyArray<Error | ((e: unknown) => boolean)>;
  maxRetries?: number;
  /**
   * https://docs.celeryq.dev/en/latest/reference/celery.app.task.html#celery.app.task.Task.default_retry_delay
   * 180 as default (which means 3 minutes).
   */
  defaultRetryDelay?: number;
  retryCount?: number;
  /**
   * seconds.
   * If set, autoretries will be delayed following the rules of exponential backoff.
   * 0 as default.
   */
  retryBackoff?: number;
  /**
   * https://docs.celeryq.dev/en/latest/userguide/tasks.html#Task.retry_backoff_max
   */
  retryBackoffMax?: number;
  /** unix timestamp */
  expires?: number;
};

export type TaskStatus = 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | 'RETRY';

export type TaskId = Branded<string, '--task-id--'>;

/** */
export type TaskResult<T> = {status: 'success'; value: T} | {status: 'failure'; error: Error; retryCount?: undefined | number};

export function unwrapResult<T>(a: Promise<TaskResult<T>>): Promise<T> {
  return a.then((x) => {
    if (x.status === 'success') {
      return x.value;
    }
    throw x.error;
  });
}

/** */
export interface AsyncResult<T> {
  taskId: TaskId;
  /**
   * get result of remote task as Promise
   */
  get(): Promise<T>;
  /**
   * get bare result of remote task.
   * Which means, AsyncTask.get could throw but getResult doesn't.
   */
  getResult(): Promise<TaskResult<T>>;
  /** confirm task status as synchronous */
  getStatus(): TaskStatus;
  retry(): AsyncResult<T>;
}

export type TaskFunc<Args extends ReadonlyArray<unknown>, R> = {
  opts?: TaskOptions;
  call: (...args: Args) => R;
};

export type TaskDefinition<
  Keys extends string,
  Fns extends (...args: ReadonlyArray<any>) => any | TaskFunc<ReadonlyArray<any>, any>,
> = Record<Keys, Fns>;

type TaskPublisher<Args extends ReadonlyArray<unknown>, R> = (...args: Args) => AsyncResult<R>;

export type CreatedTask<T extends TaskDefinition<never, never>> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer R
    ? TaskPublisher<Args, R>
    : T[K] extends TaskFunc<infer Args, infer R>
      ? TaskPublisher<Args, R>
      : never;
};

/**
 * タスク処理の結果を表す型
 * タスクの処理状態を明示的に表現
 */
export type TaskHandlerResult =
  | {status: 'accepted'; taskId: TaskId} // タスクがキューに受け入れられた
  | {status: 'processed'; taskId: TaskId; result: unknown} // タスクが処理され結果が得られた
  | {status: 'rejected'; taskId: TaskId; reason: string}; // タスクが拒否された

/**
 * メッセージブローカーインターフェース
 * タスクの発行と消費を管理
 */
export type Broker = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Producer asks worker to process the task
   */
  publishTask(taskId: TaskId, taskName: string, args: ReadonlyArray<unknown>, options?: TaskOptions): Promise<TaskId>;
  /**
   * Workers will consume task
   * @param taskName
   * @param handler
   */
  consumeTask(taskName: string, handler: (task: TaskPayload) => Promise<TaskHandlerResult>): Promise<string>;
  cancelConsumer(consumerTag: string): Promise<void>;
};

/**
 * バックエンドインターフェース
 * タスク実行結果の保存と取得を管理
 */
export type Backend = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Store a result of the task by worker.
   * @param taskId
   * @param result
   * @param expiresIn
   */
  storeResult(taskId: TaskId, result: TaskResult<unknown>, expiresIn?: number): Promise<void>;
  /**
   * Read a result by producer
   * @param taskId
   */
  getResult<T>(taskId: TaskId): Promise<TaskResult<T>>;
  startConsume<T>(taskId: TaskId, cb: (r: TaskResult<T>) => void): Promise<void>;
};

/** ワーカープールの状態 */
export const WorkerPoolState = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
} as const;

export type WorkerPoolState = (typeof WorkerPoolState)[keyof typeof WorkerPoolState];

/** タスク実行情報 */
export interface TaskPayload {
  id: TaskId;
  taskName: string;
  args: ReadonlyArray<unknown>;
  options?: TaskOptions | undefined;
}

/**
 */
export function isTaskPayload(payload: unknown): payload is TaskPayload {
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

/**
 * Mitsubaシステム全体の設定
 */
export type MitsubaOptions = {
  /** ブローカーURL または ブローカーインスタンス */
  broker: string | Broker;
  /** バックエンドURL または バックエンドインスタンス */
  backend: string | Backend;
  /** インクルードするタスクモジュール */
  include?: ReadonlyArray<string>;
  /** 結果の有効期限（秒単位） */
  resultExpires?: number;
  /** グレースフルシャットダウン時のタイムアウト（ミリ秒単位） */
  gracefulShutdownTimeout?: number;
  logger?: {
    level?: LogLevel;
    customLogger?: Logger;
  };
};

/** ロギングインターフェース */
export interface Logger {
  debug(message: string, ...args: Array<any>): void;
  info(message: string, ...args: Array<any>): void;
  warn(message: string, ...args: Array<any>): void;
  error(message: string, ...args: Array<any>): void;
}
