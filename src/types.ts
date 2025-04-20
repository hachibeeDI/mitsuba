/**
 * Mitsuba タイプ定義
 * 分散タスク処理システムの基本的な型を定義
 */

/** タスクのオプション設定 */
export type TaskOptions = {
  /** タスクの優先度（高いほど優先） */
  priority?: number;
  /** リトライ間の遅延（秒） */
  retryDelay?: number;
  /** 自動リトライする例外の種類 */
  autoretryFor?: Array<Error | ((e: unknown) => boolean)>;
  /** リトライの最大回数 */
  maxRetries?: number;
  /** 現在のリトライ回数 */
  retryCount?: number;
  /** 指数バックオフを使用するか */
  exponentialBackoff?: boolean;
  /** 結果の有効期限（秒） */
  resultExpires?: number;
};

/** タスクの状態 */
export type TaskStatus = 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | 'RETRY';

/** 非同期タスクインターフェース */
export interface AsyncTask<T> {
  /** タスクのユニークID */
  id: string;
  /** タスク結果を取得するPromise */
  promise(): Promise<T>;
  /** タスクのステータスを取得 */
  status(): Promise<TaskStatus>;
  /** タスクを再実行させる（エラー処理用） */
  retry(options?: ErrorOptions): never;
}

/** タスク定義レジストリ */
export type TaskRegistry<T extends Record<string, unknown>> = {
  [K in keyof T]:
    | {
        opts?: TaskOptions;
        call: (...args: Array<unknown>) => unknown;
      }
    | ((...args: Array<unknown>) => unknown);
};

/** メッセージブローカーインターフェース */
export interface BrokerInterface {
  /** ブローカーに接続 */
  connect(): Promise<void>;
  /** ブローカーとの接続を切断 */
  disconnect(): Promise<void>;
  /** タスクをブローカーに発行 */
  publishTask(taskName: string, args: ReadonlyArray<unknown>, options?: TaskOptions): Promise<string>;
  /** ブローカーからタスクを消費 */
  consumeTask(queueName: string, handler: (task: unknown) => Promise<unknown>): Promise<string>;
  /** コンシューマーをキャンセル */
  cancelConsumer(consumerTag: string): Promise<void>;
}

/** バックエンドインターフェース */
export interface BackendInterface {
  /** バックエンドに接続 */
  connect(): Promise<void>;
  /** バックエンドとの接続を切断 */
  disconnect(): Promise<void>;
  /** タスク結果をバックエンドに保存 */
  storeResult(taskId: string, result: unknown, expiresIn?: number): Promise<void>;
  /** バックエンドからタスク結果を取得 */
  getResult<T>(taskId: string): Promise<T>;
}

/** ワーカープールの状態 */
export enum WorkerPoolState {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
}

/** タスクペイロードインターフェース */
export interface TaskPayload {
  /** タスクID */
  id: string;
  /** タスク名 */
  taskName: string;
  /** タスク引数 */
  args: ReadonlyArray<unknown>;
  /** タスクオプション */
  options?: TaskOptions;
}

/** Mitsubaオプション */
export type MitsubaOptions = {
  /** ブローカーURL */
  broker: string;
  /** バックエンドURL */
  backend: string;
  /** インクルードするタスクモジュール */
  include?: ReadonlyArray<string>;
  /** 結果の有効期限（秒） */
  resultExpires?: number;
  /** シャットダウン時のタイムアウト（ミリ秒） */
  gracefulShutdownTimeout?: number;
  /** ロガー設定 */
  logger?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    customLogger?: Logger;
  };
};

/** ロガーインターフェース */
export interface Logger {
  debug(message: string, ...args: Array<any>): void;
  info(message: string, ...args: Array<any>): void;
  warn(message: string, ...args: Array<any>): void;
  error(message: string, ...args: Array<any>): void;
}
