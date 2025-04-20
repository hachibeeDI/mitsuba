/**
 * Mitsuba ロガー実装
 * 異なるログレベルをサポートする柔軟なロガーインターフェース
 */
import type {Logger} from './types';

/**
 * ログレベル
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
 * ロガーの設定オプション
 */
export type LoggerOptions = {
  /** ログレベル */
  level?: LogLevel;
  /** コンソール出力の有効化 */
  console?: boolean;
  /** プレフィックス */
  prefix?: string;
};

/**
 * デフォルトのロガー実装
 */
export class DefaultLogger implements Logger {
  /** 現在のログレベル */
  private level: LogLevel;
  /** コンソール出力を有効にするかどうか */
  private enableConsole: boolean;
  /** ログメッセージのプレフィックス */
  private prefix: string;

  /**
   * デフォルトロガーを初期化
   * @param options - ロガーオプション
   */
  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.enableConsole = options.console ?? true;
    this.prefix = options.prefix ?? 'Mitsuba';
  }

  /**
   * ログレベルを設定
   * @param level - 新しいログレベル
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * デバッグメッセージを出力
   * @param message - ログメッセージ
   * @param args - 追加の引数
   */
  debug(message: string, ...args: Array<any>): void {
    if (this.level <= LogLevel.DEBUG) {
      this.log('debug', message, args);
    }
  }

  /**
   * 情報メッセージを出力
   * @param message - ログメッセージ
   * @param args - 追加の引数
   */
  info(message: string, ...args: Array<any>): void {
    if (this.level <= LogLevel.INFO) {
      this.log('info', message, args);
    }
  }

  /**
   * 警告メッセージを出力
   * @param message - ログメッセージ
   * @param args - 追加の引数
   */
  warn(message: string, ...args: Array<any>): void {
    if (this.level <= LogLevel.WARN) {
      this.log('warn', message, args);
    }
  }

  /**
   * エラーメッセージを出力
   * @param message - ログメッセージ
   * @param args - 追加の引数
   */
  error(message: string, ...args: Array<any>): void {
    if (this.level <= LogLevel.ERROR) {
      this.log('error', message, args);
    }
  }

  /**
   * ログ出力の共通処理
   * @param level - ログレベル
   * @param message - ログメッセージ
   * @param args - 追加の引数
   * @private
   */
  private log(level: string, message: string, args: Array<any>): void {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${this.prefix}] [${level.toUpperCase()}] ${message}`;

    if (this.enableConsole) {
      switch (level) {
        case 'debug':
          console.debug(formattedMessage, ...args);
          break;
        case 'info':
          console.info(formattedMessage, ...args);
          break;
        case 'warn':
          console.warn(formattedMessage, ...args);
          break;
        case 'error':
          console.error(formattedMessage, ...args);
          break;
        default:
          console.log(formattedMessage, ...args);
      }
    }
  }
}

/**
 * 何もしないロガー実装（ログ出力を完全に無効化）
 */
export class NoopLogger implements Logger {
  /**
   * デバッグメッセージ（何もしない）
   */
  debug(): void {
    // 何もしない
  }

  /**
   * 情報メッセージ（何もしない）
   */
  info(): void {
    // 何もしない
  }

  /**
   * 警告メッセージ（何もしない）
   */
  warn(): void {
    // 何もしない
  }

  /**
   * エラーメッセージ（何もしない）
   */
  error(): void {
    // 何もしない
  }
}

/**
 * グローバルロガーのインスタンス
 */
let globalLogger: Logger = new DefaultLogger();

/**
 * グローバルロガーを設定
 * @param logger - 新しいロガーインスタンス
 */
export function setLogger(logger: Logger): void {
  globalLogger = logger;
}

/**
 * 現在のグローバルロガーを取得
 * @returns 現在のロガーインスタンス
 */
export function getLogger(): Logger {
  return globalLogger;
}

/**
 * ロガーファクトリ
 * @param options - ロガーオプション
 * @returns 新しいロガーインスタンス
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new DefaultLogger(options);
}
