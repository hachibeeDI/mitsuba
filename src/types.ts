/**
 * Mitsuba タイプ定義
 * 分散タスク処理システムの基本的な型を定義
 */

export type Branded<T, Brand> = T & {readonly __brand: Brand};

/** タスクの実行オプション */
export type TaskOptions = {
  /** 高いほど優先して実行 */
  priority?: number;
  /** 秒単位 */
  retryDelay?: number;
  /** 自動リトライする例外の種類 */
  autoretryFor?: Array<Error | ((e: unknown) => boolean)>;
  maxRetries?: number;
  retryCount?: number;
  /** バックオフ処理にて指数関数的に待機時間を増加させる */
  exponentialBackoff?: boolean;
  /** 秒単位 */
  resultExpires?: number;
};

/** タスクの状態 */
export type TaskStatus = 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | 'RETRY';

export type TaskId = Branded<string, '--task-id--'>;

/**
 * 非同期タスクインターフェース
 * タスク実行の状態管理と結果取得を行う
 */
export interface AsyncTask<T> {
  getTaskId(): Promise<TaskId>;
  /** タスク結果を取得 */
  get(): Promise<T>;
  status(): Promise<TaskStatus>;
  /** エラー時の再試行 */
  retry(options?: ErrorOptions): never;
}

export type TaskFunc<Args extends ReadonlyArray<unknown>, R> = {
  opts?: TaskOptions;
  call: (...args: Args) => R;
};

/**
 * タスク定義レジストリ
 * システムに登録する処理関数のマッピング
 */
export type TaskRegistry<
  Keys extends string,
  Fns extends (...args: ReadonlyArray<any>) => any | TaskFunc<ReadonlyArray<any>, any>,
> = Record<Keys, Fns>;

type TaskPublisher<Args extends ReadonlyArray<unknown>, R> = (...args: Args) => AsyncTask<R>;

export type CreatedTask<T extends TaskRegistry<never, never>> = {
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
  publishTask(taskName: string, args: ReadonlyArray<unknown>, options?: TaskOptions): Promise<TaskId>;
  consumeTask(queueName: string, handler: (task: TaskPayload) => Promise<TaskHandlerResult>): Promise<string>;
  cancelConsumer(consumerTag: string): Promise<void>;
};

/**
 * バックエンドインターフェース
 * タスク実行結果の保存と取得を管理
 */
export type Backend = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  storeResult(taskId: TaskId, result: unknown, expiresIn?: number): Promise<void>;
  getResult<T>(taskId: TaskId): Promise<T>;
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
    level?: 'debug' | 'info' | 'warn' | 'error';
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
