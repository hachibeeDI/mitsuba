/**
 * Mitsuba エラー定義
 * システム内で使用される様々なエラークラスを定義
 */

/**
 * Mitsubaの基本エラークラス
 */
export class MitsubaError extends Error {
  name = 'MitsubaError';

  /**
   * Mitsubaエラーを初期化
   * @param message - エラーメッセージ
   * @param options - エラーオプション
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);

    // Errorの継承をサポートしないランタイムのためのWorkaround
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * ブローカー接続エラー
 */
export class BrokerConnectionError extends MitsubaError {
  name = 'BrokerConnectionError';

  /**
   * ブローカー接続エラーを初期化
   * @param message - エラーメッセージ
   * @param options - エラーオプション
   */
  constructor(message: string, options?: ErrorOptions) {
    super(`Broker connection error: ${message}`, options);
  }
}

/**
 * ブローカー操作エラー
 */
export class BrokerError extends MitsubaError {
  name = 'BrokerError';

  /**
   * ブローカー操作エラーを初期化
   * @param message - エラーメッセージ
   * @param options - エラーオプション
   */
  constructor(message: string, options?: ErrorOptions) {
    super(`Broker error: ${message}`, options);
  }
}

/**
 * バックエンド接続エラー
 */
export class BackendConnectionError extends MitsubaError {
  name = 'BackendConnectionError';

  /**
   * バックエンド接続エラーを初期化
   * @param message - エラーメッセージ
   * @param options - エラーオプション
   */
  constructor(message: string, options?: ErrorOptions) {
    super(`Backend connection error: ${message}`, options);
  }
}

/**
 * タスク実行エラー
 */
export class TaskExecutionError extends MitsubaError {
  name = 'TaskExecutionError';

  /**
   * タスク実行エラーを初期化
   * @param taskId - タスクID
   * @param taskName - タスク名
   * @param options - エラーオプション
   */
  constructor(taskId: string, taskName: string, options?: ErrorOptions) {
    super(`Task execution failed - ID: ${taskId}, Name: ${taskName}`, options);
  }
}

/**
 * タスク取得エラー
 */
export class TaskRetrievalError extends MitsubaError {
  name = 'TaskRetrievalError';
  reason: string;

  /**
   * @param taskId - タスクID
   * @param options - エラーオプション
   */
  constructor(taskId: string, options?: ErrorOptions & {reason?: string}) {
    super(`ID: ${taskId} - ${options?.reason ?? 'Failed to retrieve task result '}`, options);
    this.reason = options?.reason ?? '';
  }
}

/**
 * タスクタイムアウトエラー
 */
export class TaskTimeoutError extends MitsubaError {
  name = 'TaskTimeoutError';

  /**
   * タスクタイムアウトエラーを初期化
   * @param taskId - タスクID
   * @param timeoutMs - タイムアウト時間（ミリ秒）
   */
  constructor(taskId: string, timeoutMs: number) {
    super(`Task timed out after ${timeoutMs}ms - ID: ${taskId}`);
  }
}

/**
 * タスクリトライエラー
 */
export class TaskRetryError extends MitsubaError {
  name = 'TaskRetryError';
  readonly attempt: number;

  /**
   * タスクリトライエラーを初期化
   * @param taskId - タスクID
   * @param attempt - 試行回数
   * @param options - エラーオプション
   */
  constructor(taskId: string, attempt: number, options?: ErrorOptions) {
    super(`Task retry requested - ID: ${taskId}, Attempt: ${attempt}`, options);
    this.attempt = attempt;
  }
}

/**
 * タスク未登録エラー
 */
export class TaskNotRegisteredError extends MitsubaError {
  name = 'TaskNotRegisteredError';

  /**
   * タスク未登録エラーを初期化
   * @param taskName - タスク名
   */
  constructor(taskName: string) {
    super(`Task ${taskName} not found in registry`);
  }
}

/**
 * ワーカー操作エラー
 */
export class WorkerOperationError extends MitsubaError {
  name = 'WorkerOperationError';

  /**
   * ワーカー操作エラーを初期化
   * @param message - エラーメッセージ
   * @param options - エラーオプション
   */
  constructor(message: string, options?: ErrorOptions) {
    super(`Worker operation error: ${message}`, options);
  }
}
