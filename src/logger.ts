/**
 * Mitsuba ロガー実装
 * システム内のイベント、エラー、デバッグ情報などを統一的に記録する機能を提供
 */

/**
 * ログレベル定義
 */
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * ロガー設定オプション
 */
export type LoggerOptions = {
  level?: LogLevel;
};

/**
 * Loggerインターフェース
 * アプリケーション全体で一貫したロギングを可能にする
 */
export interface Logger {
  debug(message: string, ...args: Array<any>): void;
  info(message: string, ...args: Array<any>): void;
  warn(message: string, ...args: Array<any>): void;
  error(message: string, ...args: Array<any>): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
}

// グローバルロガーインスタンス
let globalLogger: Logger;

/**
 * デフォルトロガー実装
 * コンソールに各レベルのログを出力
 */
export class DefaultLogger implements Logger {
  private level: LogLevel;

  constructor(options?: LoggerOptions) {
    this.level = options?.level ?? LogLevel.DEBUG;
  }

  debug(message: string, ...args: Array<any>): void {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }

  info(message: string, ...args: Array<any>): void {
    if (this.level <= LogLevel.INFO) {
      console.info(`[INFO] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: Array<any>): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }

  error(message: string, ...args: Array<any>): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(`[ERROR] ${message}`, ...args);
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }
}

/**
 * 何も出力しないロガー実装
 * ロギングを完全に無効化したい場合に使用
 */
export class NoopLogger implements Logger {
  debug(_message: string, ..._args: Array<any>): void {
    // 何もしない
  }

  info(_message: string, ..._args: Array<any>): void {
    // 何もしない
  }

  warn(_message: string, ..._args: Array<any>): void {
    // 何もしない
  }

  error(_message: string, ..._args: Array<any>): void {
    // 何もしない
  }

  setLevel(_level: LogLevel): void {
    // 何もしない
  }

  getLevel(): LogLevel {
    return LogLevel.SILENT;
  }
}

/**
 * グローバルロガーを設定
 */
export function setLogger(logger: Logger): void {
  globalLogger = logger;
}

/**
 * 現在のグローバルロガーを取得
 * 未設定の場合はデフォルトロガーを作成して返す
 */
export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new DefaultLogger();
  }
  return globalLogger;
}

/**
 * 新しいロガーインスタンスを作成
 */
export function createLogger(options?: LoggerOptions): Logger {
  return new DefaultLogger(options);
}
