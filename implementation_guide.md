# Mitsuba 実装ガイド

## 問題点と修正案

プランを分析した結果、いくつかの問題点があります：
1. **型定義の不足**
   - `chord`, `sequence` 関数の型定義が曖昧

2. **エラーハンドリングの詳細が不十分**
   - リトライロジックはより詳細な定義が必要
   - 例外の型チェックメカニズムの実装方法が不明確

## 実装ステップ

### 1. コアインターフェースの定義

`src/types.ts` に基本型定義を作成します：

```typescript
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
export type AsyncTask<T> = {
  /** タスクのユニークID */
  id: string;
  /** タスク結果を取得するPromise */
  promise(): Promise<T>;
  /** タスクのステータスを取得 */
  status(): Promise<TaskStatus>;
  /** タスクを再実行させる（エラー処理用） */
  retry(options?: ErrorOptions): never;
};

/** タスク定義レジストリ */
export type TaskRegistry<T extends Record<string, unknown>> = {
  [K in keyof T]: {
    opts?: TaskOptions;
    call: (...args: Array<unknown>) => unknown;
  } | ((...args: Array<unknown>) => unknown);
};

/** メッセージブローカーインターフェース */
export type BrokerInterface = {
  /** ブローカーに接続 */
  connect(): Promise<void>;
  /** ブローカーとの接続を切断 */
  disconnect(): Promise<void>;
  /** タスクをブローカーに発行 */
  publishTask(taskName: string, args: ReadonlyArray<unknown>, options?: TaskOptions): Promise<string>;
  /** ブローカーからタスクを消費 */
  consumeTask(queueName: string, handler: (task: unknown) => Promise<unknown>): Promise<void>;
};

/** バックエンドインターフェース */
export type BackendInterface = {
  /** バックエンドに接続 */
  connect(): Promise<void>;
  /** バックエンドとの接続を切断 */
  disconnect(): Promise<void>;
  /** タスク結果をバックエンドに保存 */
  storeResult(taskId: string, result: unknown, expiresIn?: number): Promise<void>;
  /** バックエンドからタスク結果を取得 */
  getResult<T>(taskId: string): Promise<T>;
};
```

### 2. ブローカーとバックエンドの実装

#### 2.1 AMQP ブローカー実装

`src/brokers/amqp.ts` を作成：

```typescript
import * as amqp from 'amqplib';
import { BrokerInterface, TaskOptions } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class AMQPBroker implements BrokerInterface {
  /** AMQPコネクション */
  private connection: amqp.Connection | null = null;
  /** AMQPチャネル */
  private channel: amqp.Channel | null = null;
  /** ブローカーURL */
  private url: string;

  /**
   * AMQPブローカーを初期化
   * @param url - AMQPブローカーのURL
   */
  constructor(url: string) {
    this.url = url;
  }

  /**
   * ブローカーに接続
   * @throws 接続に失敗した場合
   */
  async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
    } catch (error) {
      console.error('Failed to connect to AMQP broker:', error);
      throw new BrokerConnectionError('Failed to establish connection', { cause: error as Error });
    }
  }

  /**
   * ブローカーとの接続を切断
   */
  async disconnect(): Promise<void> {
    if (this.channel) {
      await this.channel.close();
    }
    if (this.connection) {
      await this.connection.close();
    }
  }

  /**
   * タスクをブローカーに発行
   * @param taskName - タスク名
   * @param args - タスク引数
   * @param options - タスクオプション
   * @returns タスクID
   * @throws ブローカーに接続していない場合
   */
  async publishTask(taskName: string, args: ReadonlyArray<unknown>, options?: TaskOptions): Promise<string> {
    if (!this.channel) {
      throw new Error('Broker not connected');
    }

    const taskId = generateUniqueId();
    const payload: TaskPayload = {
      id: taskId,
      taskName,
      args,
      options,
    };

    // キューの確保
    await this.channel.assertQueue(taskName, { durable: true });
    
    // メッセージの発行
    const priority = options?.priority || 0;
    this.channel.sendToQueue(
      taskName,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        priority,
        messageId: taskId,
      }
    );

    return taskId;
  }

  /**
   * ブローカーからタスクを消費
   * @param queueName - キュー名
   * @param handler - タスク処理ハンドラー
   * @throws ブローカーに接続していない場合
   */
  async consumeTask(queueName: string, handler: (task: unknown) => Promise<unknown>): Promise<void> {
    if (!this.channel) {
      throw new Error('Broker not connected');
    }

    // キューの確保
    await this.channel.assertQueue(queueName, { durable: true });
    
    this.channel.prefetch(1);
    this.channel.consume(queueName, async (msg) => {
      if (!msg) return;
      
      try {
        const payload = JSON.parse(msg.content.toString());
        await handler(payload);
        this.channel?.ack(msg);
      } catch (error) {
        // エラー処理
        console.error('Error processing task:', error);
        this.channel?.nack(msg, false, true);
      }
    });
  }
}

/**
 * ユニークなIDを生成
 * @returns ユニークID
 */
function generateUniqueId(): string {
  return uuidv4();
}
```

#### 2.2 AMQP バックエンド実装

`src/backends/amqp.ts` を作成：

```typescript
import * as amqp from 'amqplib';
import { BackendInterface } from '../types';

export class AMQPBackend implements BackendInterface {
  /** AMQPコネクション */
  private connection: amqp.Connection | null = null;
  /** AMQPチャネル */
  private channel: amqp.Channel | null = null;
  /** バックエンドURL */
  private url: string;
  /** 結果交換機名 */
  private resultExchange = 'mitsuba.results';

  /**
   * AMQPバックエンドを初期化
   * @param url - AMQPバックエンドのURL
   */
  constructor(url: string) {
    this.url = url;
  }

  /**
   * バックエンドに接続
   * @throws 接続に失敗した場合
   */
  async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(this.resultExchange, 'direct', { durable: true });
    } catch (error) {
      console.error('Failed to connect to AMQP backend:', error);
      throw new BackendConnectionError('Failed to establish connection', { cause: error as Error });
    }
  }

  /**
   * バックエンドとの接続を切断
   */
  async disconnect(): Promise<void> {
    if (this.channel) {
      await this.channel.close();
    }
    if (this.connection) {
      await this.connection.close();
    }
  }

  /**
   * タスク結果をバックエンドに保存
   * @param taskId - タスクID
   * @param result - タスク結果
   * @param expiresIn - 結果の有効期限（秒）
   * @throws バックエンドに接続していない場合
   */
  async storeResult(taskId: string, result: unknown, expiresIn = 3600): Promise<void> {
    if (!this.channel) {
      throw new Error('Backend not connected');
    }

    const payload = {
      taskId,
      result,
      timestamp: Date.now(),
      expires: Date.now() + expiresIn * 1000,
    };

    this.channel.publish(
      this.resultExchange,
      taskId,
      Buffer.from(JSON.stringify(payload)),
      { expiration: expiresIn * 1000 }
    );
  }

  /**
   * バックエンドからタスク結果を取得
   * @param taskId - タスクID
   * @returns タスク結果
   * @throws バックエンドに接続していない場合またはタイムアウト
   */
  async getResult<T>(taskId: string): Promise<T> {
    if (!this.channel) {
      throw new BackendConnectionError('Backend not connected');
    }

    // タスク結果取得用のテンポラリキュー作成
    const { queue } = await this.channel.assertQueue('', { exclusive: true });
    
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.channel?.unbindQueue(queue, this.resultExchange, taskId);
        reject(new TaskTimeoutError(taskId, 30000));
      }, 30000); // 30秒タイムアウト

      this.channel!.consume(queue, (msg) => {
        if (msg) {
          clearTimeout(timeout);
          try {
            const content = JSON.parse(msg.content.toString());
            this.channel!.ack(msg);
            this.channel!.unbindQueue(queue, this.resultExchange, taskId);
            resolve(content.result as T);
          } catch (error) {
            reject(new TaskRetrievalError(taskId, { cause: error as Error }));
          }
        }
      });

      // 結果交換機をバインド
      this.channel!.bindQueue(queue, this.resultExchange, taskId);
    });
  }
}
```

### 3. メインアプリケーションの実装

`src/mitsuba.ts` を作成：

```typescript
import { BrokerInterface, BackendInterface, TaskOptions, AsyncTask, TaskRegistry, TaskStatus } from './types';
import { AMQPBroker } from './brokers/amqp';
import { AMQPBackend } from './backends/amqp';

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
};

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
  
  /**
   * タスク取得エラーを初期化
   * @param taskId - タスクID
   * @param options - エラーオプション
   */
  constructor(taskId: string, options?: ErrorOptions) {
    super(`Failed to retrieve task result - ID: ${taskId}`, options);
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
  
  /**
   * タスクリトライエラーを初期化
   * @param taskId - タスクID
   * @param attempt - 試行回数
   * @param options - エラーオプション
   */
  constructor(taskId: string, attempt: number, options?: ErrorOptions) {
    super(`Task retry requested - ID: ${taskId}, Attempt: ${attempt}`, options);
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
 * 非同期タスク実装クラス
 */
class TaskImplementation<T> implements AsyncTask<T> {
  /**
   * 非同期タスクを初期化
   * @param id - タスクID
   * @param backend - バックエンドインスタンス
   */
  constructor(
    public id: string,
    private backend: BackendInterface
  ) {}

  /**
   * タスク結果を取得するPromise
   * @returns タスク結果
   */
  async promise(): Promise<T> {
    return this.backend.getResult<T>(this.id);
  }

  /**
   * タスクのステータスを取得
   * @returns タスクステータス
   */
  async status(): Promise<TaskStatus> {
    try {
      await this.backend.getResult<T>(this.id);
      return 'SUCCESS';
    } catch (e) {
      // 状態チェックはより複雑な実装が必要
      return 'PENDING';
    }
  }

  /**
   * タスクを再実行させる（エラー処理用）
   * @param options - リトライオプション
   * @throws TaskRetryError タスクのリトライを要求する例外
   */
  retry(options?: ErrorOptions): never {
    throw new TaskRetryError(this.id, 0, options);
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
  /** Mitsubaオプション */
  private options: MitsubaOptions;

  /**
   * Mitsubaを初期化
   * @param name - アプリケーション名
   * @param options - Mitsubaオプション
   */
  constructor(
    public readonly name: string,
    options: MitsubaOptions
  ) {
    this.options = options;
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
      return new AMQPBroker(brokerUrl);
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
  }

  /**
   * Mitsubaとの接続を閉じる
   */
  async close(): Promise<void> {
    await this.broker.disconnect();
    await this.backend.disconnect();
  }

  /**
   * タスクレジストリからタスク実行関数を作成
   * @param registry - タスクレジストリ
   * @returns タスク実行関数マップ
   */
  createTask<T extends TaskRegistry<T>>(registry: T): { [K in keyof T]: (...args: Array<unknown>) => AsyncTask<unknown> } {
    const result = {} as { [K in keyof T]: (...args: Array<unknown>) => AsyncTask<unknown> };

    for (const [taskName, task] of Object.entries(registry)) {
      if (typeof task === 'function') {
        // 関数の場合
        result[taskName as keyof T] = async (...args: Array<unknown>) => {
          const taskId = await this.broker.publishTask(taskName, args, undefined);
          return new TaskImplementation<unknown>(taskId, this.backend);
        };
      } else {
        // オプション付きタスクの場合
        const { opts, call } = task;
        result[taskName as keyof T] = async (...args: Array<unknown>) => {
          const taskId = await this.broker.publishTask(taskName, args, opts);
          return new TaskImplementation<unknown>(taskId, this.backend);
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
  async start(taskNames: ReadonlyArray<string>, concurrency: number): Promise<void> {
    if (taskNames.length === 0) {
      console.warn('[WorkerPool] No tasks registered, worker will not consume any messages');
      return;
    }
    
    const taskHandler = new TaskHandler(
      this.taskExecutor,
      this.retryPolicy,
      this.broker,
      this.backend
    );
    
    // 各タスクタイプごとにコンシューマーを開始
    // ネストしたforループをflat mapに変換
    const workerPromises = taskNames.flatMap(taskName => 
      // 各タスクに対して指定された数のワーカーを生成
      Array.from({ length: concurrency }, () => 
        this.broker.consumeTask(taskName, payload => 
          taskHandler.handleTask(payload)
        )
      )
    );
    
    this.workers = workerPromises;
    
    console.log(`[WorkerPool] Started ${concurrency} worker(s) for ${taskNames.length} task type(s)`);
    
    // 全てのワーカーの準備完了を待つ
    await Promise.all(this.workers);
  }
  
  /**
   * タスクレジストリを読み込む
   * @returns タスクレジストリ
   * @private
   */
  private loadTaskRegistry(): Record<string, any> {
    // 実際の実装ではincludeオプションからタスクを動的に読み込む
    // このサンプル実装では空のレジストリを返す
    return {};
  }
  
  /**
   * 登録されたタスク名の一覧を取得
   * @returns タスク名配列
   * @private
   */
  private getRegisteredTaskNames(): Array<string> {
    // 実際の実装ではタスクレジストリからタスク名を抽出
    // このサンプル実装では空の配列を返す
    return [];
  }
}

/**
 * タスク実行ポリシー
 */
class RetryPolicy {
  /**
   * リトライポリシーを初期化
   * @param options - Mitsubaオプション
   */
  constructor(private options: MitsubaOptions) {}
  
  /**
   * タスクをリトライすべきかを判断
   * @param error - 発生したエラー
   * @param options - タスクオプション
   * @returns リトライすべき場合はtrue
   */
  shouldRetry(error: Error, options?: TaskOptions): boolean {
    // TaskRetryErrorは明示的なリトライ要求なので、常にtrueを返す
    if (error instanceof TaskRetryError) {
      return true;
    }
    
    // リトライ回数の上限チェック
    const maxRetries = options?.maxRetries || 3;
    const currentRetries = options?.retryCount || 0;
    
    if (currentRetries >= maxRetries) {
      return false;
    }
    
    // 自動リトライ対象のエラーかをチェック
    const autoRetryFor = options?.autoretryFor || [];
    
    if (autoRetryFor.length === 0) {
      // デフォルトではネットワークエラーのみリトライ
      return error.message.includes('network') || error.message.includes('timeout');
    }
    
    // autoretryForの条件に一致するかチェック
    return autoRetryFor.some(retryCondition => {
      if (typeof retryCondition === 'function') {
        return retryCondition(error);
      } else {
        return error instanceof retryCondition.constructor;
      }
    });
  }
  
  /**
   * リトライ用の遅延時間を計算
   * @param options - タスクオプション
   * @returns 遅延時間（秒）
   */
  getRetryDelay(options?: TaskOptions): number {
    const baseDelay = options?.retryDelay || 5; // デフォルト5秒
    const retryCount = options?.retryCount || 0;
    
    // 指数バックオフ（オプション）
    if (options?.exponentialBackoff) {
      return baseDelay * Math.pow(2, retryCount);
    }
    
    return baseDelay;
  }
}

/**
 * タスク実行クラス
 */
class TaskExecutor {
  /**
   * タスク実行クラスを初期化
   * @param taskRegistry - タスクレジストリ
   * @param options - Mitsubaオプション
   */
  constructor(
    private taskRegistry: Record<string, any>,
    private options: MitsubaOptions
  ) {}
  
  /**
   * タスクを実行
   * @param taskName - タスク名
   * @param args - タスク引数
   * @returns タスク実行結果
   * @throws タスクが存在しない場合や実行エラー
   */
  async executeTask(taskName: string, args: ReadonlyArray<unknown>): Promise<unknown> {
    // タスク定義を取得
    const taskDef = this.taskRegistry[taskName];
    if (!taskDef) {
      throw new TaskNotRegisteredError(taskName);
    }
    
    // タスク関数を取得
    const taskFn = typeof taskDef === 'function' ? taskDef : taskDef.call;
    
    try {
      // タスクを実行して結果を返す
      return await taskFn(...args);
    } catch (error) {
      // エラーをラップして再スロー
      throw new TaskExecutionError('unknown', taskName, { cause: error as Error });
    }
  }
  
  /**
   * 結果の保存期間を取得
   * @param options - タスクオプション
   * @returns 保存期間（秒）
   */
  getResultExpiration(options?: TaskOptions): number {
    return options?.resultExpires || this.options.resultExpires || 3600;
  }
}

/**
 * タスクペイロードインターフェース */
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

/**
 * タスク処理ハンドラ
 */
class TaskHandler {
  /**
   * タスク処理ハンドラを初期化
   * @param taskExecutor - タスク実行クラス
   * @param retryPolicy - リトライポリシー
   * @param broker - ブローカーインスタンス
   * @param backend - バックエンドインスタンス
   */
  constructor(
    private taskExecutor: TaskExecutor,
    private retryPolicy: RetryPolicy,
    private broker: BrokerInterface,
    private backend: BackendInterface
  ) {}
  
  /**
   * タスクを処理
   * @param payload - タスクペイロード
   */
  async handleTask(payload: unknown): Promise<void> {
    // ペイロードの型チェック
    if (!this.isValidTaskPayload(payload)) {
      console.error('[Worker] Invalid task payload received:', payload);
      return;
    }

    const { id: taskId, taskName, args, options } = payload;
    
    try {
      // 各タスクの実行を個別の関数に分離し、詳細なログを取得できるようにする
      const result = await this.executeTaskWithLogging(taskId, taskName, args, options);
      
      // 処理結果を永続化してタスクの完了を記録
      const expiresIn = this.taskExecutor.getResultExpiration(options);
      await this.backend.storeResult(taskId, result, expiresIn);
      
      console.log(`[Worker] Task ${taskId} completed successfully`);
    } catch (error) {
      console.error(`[Worker] Task ${taskId} failed:`, error);
      
      // Error型でない可能性があるため標準化して扱う
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      
      // リトライ戦略をエラー状態に応じて適用
      const taskRetried = await this.handleTaskRetry(taskId, taskName, args, options, normalizedError);
      
      // リトライされなかった場合は、将来の分析のために失敗を永続化
      if (!taskRetried) {
        await this.recordTaskFailure(taskId, normalizedError, options);
      }
    }
  }

  /**
   * タスクを実行してログを記録する
   * @param taskId - タスクID
   * @param taskName - タスク名
   * @param args - タスク引数
   * @param options - タスクオプション
   * @returns タスク実行結果
   * @private
   */
  private async executeTaskWithLogging(
    taskId: string,
    taskName: string,
    args: ReadonlyArray<unknown>,
    options?: TaskOptions
  ): Promise<unknown> {
    // 実行のトレーサビリティのためにタスク詳細を記録
    console.log(`[Worker] Executing task ${taskName}(${JSON.stringify(args)}) with ID ${taskId}`);
    
    // 実際のタスク実行を登録済みの実行エンジンに委譲
    return await this.taskExecutor.executeTask(taskName, args);
  }

  /**
   * タスクのリトライ処理を行う
   * @param taskId - タスクID
   * @param taskName - タスク名
   * @param args - タスク引数
   * @param options - タスクオプション
   * @param error - 発生したエラー
   * @returns リトライが行われる場合はtrue
   * @private
   */
  private async handleTaskRetry(
    taskId: string,
    taskName: string,
    args: ReadonlyArray<unknown>,
    options?: TaskOptions,
    error?: Error
  ): Promise<boolean> {
    if (!error) {
      return false;
    }
    
    // TaskRetryErrorは明示的なリトライ要求を含む可能性があるため特別処理
    let retryAttempt = options?.retryCount || 0;
    let retryOptions = { ...options };
    
    if (error instanceof TaskRetryError) {
      // ユーザーコードからのリトライ要求の情報を活用
      retryAttempt = error.attempt || retryAttempt;
      
      // 根本原因のスタックトレースを維持するためにcauseを記録
      if (error.cause) {
        console.error(`[Worker] Original error cause:`, error.cause);
      }
    }
    
    // リトライポリシーでリトライ可能と判断された場合のみ再実行
    if (this.retryPolicy.shouldRetry(error, retryOptions)) {
      const retryDelay = this.retryPolicy.getRetryDelay(retryOptions);
      const retryCount = retryAttempt + 1;
      
      console.log(`[Worker] Retrying task ${taskId} after ${retryDelay}s (attempt ${retryCount})`);
      
      // 同時実行によるリソース競合を避けるため遅延後に再実行
      setTimeout(async () => {
        await this.broker.publishTask(taskName, args, {
          ...retryOptions,
          retryCount
        });
      }, retryDelay * 1000);
      
      return true;
    }
    
    return false;
  }

  /**
   * タスクの失敗を記録する
   * @param taskId - タスクID
   * @param error - 発生したエラー
   * @param options - タスクオプション
   * @private
   */
  private async recordTaskFailure(
    taskId: string,
    error: Error,
    options?: TaskOptions
  ): Promise<void> {
    // 失敗した結果の保持期間を設定（デバッグや監査目的）
    const expiresIn = this.taskExecutor.getResultExpiration(options);
    
    // エラーオブジェクトをJSONとして保存可能な形式に変換
    const errorData = error instanceof Error 
      ? { message: error.message, name: error.name, stack: error.stack }
      : { message: String(error) };
    
    // 障害回復やデバッグのためにエラー情報を永続化
    await this.backend.storeResult(taskId, { error: errorData }, expiresIn);
    
    console.log(`[Worker] Task ${taskId} permanently failed, error recorded`);
  }

  /**
   * ペイロードがTaskPayload型として有効か検証する
   * @param payload - 検証するペイロード
   * @returns 有効な場合はtrue
   * @private
   */
  private isValidTaskPayload(payload: unknown): payload is TaskPayload {
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    
    const p = payload as Record<string, unknown>;
    
    // 必須フィールドの存在チェック
    if (typeof p.id !== 'string' || !p.id) {
      return false;
    }
    
    if (typeof p.taskName !== 'string' || !p.taskName) {
      return false;
    }
    
    if (!Array.isArray(p.args)) {
      return false;
    }
    
    // optionsはオプショナル
    if (p.options !== undefined && (typeof p.options !== 'object' || p.options === null)) {
      return false;
    }
    
    return true;
  }
}

/**
 * ワーカープール
 */
class WorkerPool {
  /** ワーカープロミス配列 */
  private workers: Array<Promise<void>> = [];
  /** 消費者タグのマップ（キャンセル用） */
  private consumerTags: Map<string, string> = new Map();
  /** 停止フラグ */
  private isShuttingDown: boolean = false;
  /** 停止タイムアウト（ミリ秒） */
  private readonly stopTimeoutMs: number = 5000;

  /**
   * ワーカープールを初期化
   * @param broker - ブローカーインスタンス
   * @param backend - バックエンドインスタンス
   * @param taskExecutor - タスク実行クラス
   * @param retryPolicy - リトライポリシー
   */
  constructor(
    private broker: BrokerInterface,
    private backend: BackendInterface,
    private taskExecutor: TaskExecutor,
    private retryPolicy: RetryPolicy
  ) {}
  
  /**
   * ワーカープールを開始
   * @param taskNames - 処理対象のタスク名配列
   * @param concurrency - 並行処理数
   */
  async start(taskNames: ReadonlyArray<string>, concurrency: number): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('[WorkerPool] Cannot start workers during shutdown');
    }

    if (taskNames.length === 0) {
      console.warn('[WorkerPool] No tasks registered, worker will not consume any messages');
      return;
    }
    
    const taskHandler = new TaskHandler(
      this.taskExecutor,
      this.retryPolicy,
      this.broker,
      this.backend
    );
    
    // 各タスクタイプごとにコンシューマーを開始
    const workerPromises = taskNames.flatMap(taskName => 
      // 各タスクに対して指定された数のワーカーを生成
      Array.from({ length: concurrency }, async (_, index) => {
        // consumeTaskの結果からconsumerTagを取得して保存
        const consumerTag = `worker-${taskName}-${index}`;
        const result = await this.broker.consumeTask(taskName, payload => 
          taskHandler.handleTask(payload)
        );
        
        // consumerTagとその実際の値をマップに保存
        if (typeof result === 'string' && result) {
          this.consumerTags.set(consumerTag, result);
        }
        
        // ワーカーループ - シャットダウンフラグをチェックして適切に終了
        while (!this.isShuttingDown) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`[WorkerPool] Worker ${consumerTag} shutting down`);
      })
    );
    
    this.workers = workerPromises;
    
    console.log(`[WorkerPool] Started ${concurrency} worker(s) for ${taskNames.length} task type(s)`);
    
    // 全てのワーカーの準備完了を待つ
    await Promise.all(this.workers).catch(err => {
      console.error('[WorkerPool] Error in worker pool:', err);
    });
  }
  
  /**
   * ワーカープールを停止する
   */
  async stop(): Promise<void> {
    // すでに停止している場合は即座に完了する
    if (this.state === WorkerPoolState.STOPPED) {
      return;
    }

    // 停止中にセットして、新しいタスクが開始されるのを防ぐ
    this.state = WorkerPoolState.STOPPING;
    
    try {
      await this.cancelAllConsumers();
      await this.waitForWorkerCompletion();
      await this.closeAllConnections();
      this.resetPool();
      this.state = WorkerPoolState.STOPPED;
    } catch (error) {
      this.state = WorkerPoolState.ERROR;
      this.logger.error('Failed to stop worker pool', error);
      throw error;
    }
  }

  /**
   * すべてのコンシューマーをキャンセルする
   * @private
   */
  private async cancelAllConsumers(): Promise<void> {
    if (this.consumerTags.size === 0) {
      this.logger.info('No consumers to cancel');
      return;
    }
    
    this.logger.info(`Cancelling ${this.consumerTags.size} consumers`);
    
    // 全てのコンシューマーキャンセルを並行して実行し、各結果をログに記録する
    const results = await Promise.allSettled(
      Array.from(this.consumerTags).map(tag => this.cancelConsumer(tag))
    );
    
    // 結果をログに出力する
    results.forEach((result, index) => {
      const tag = Array.from(this.consumerTags)[index];
      if (result.status === 'fulfilled') {
        this.logger.info(`Successfully cancelled consumer ${tag}`);
      } else {
        this.logger.warn(`Failed to cancel consumer ${tag}: ${result.reason}`);
      }
    });
    
    // エラーがあった場合でも続行するが、結果をログに残す
    const failedCount = results.filter(r => r.status === 'rejected').length;
    if (failedCount > 0) {
      this.logger.warn(`${failedCount} consumers failed to cancel properly`);
    }
  }

  /**
   * すべてのワーカーの完了を待機する
   * @private
   */
  private async waitForWorkerCompletion(): Promise<void> {
    if (this.workers.length === 0) {
      this.logger.info('No workers to wait for');
      return;
    }
    
    this.logger.info(`Waiting for ${this.workers.length} workers to complete`);
    
    // タイムアウト付きでワーカーの完了を待機
    const timeout = this.options.gracefulShutdownTimeout || 30000;
    let remaining = timeout;
    const checkInterval = 1000;
    
    const start = Date.now();
    
    while (this.activeTaskCount > 0 && remaining > 0) {
      this.logger.info(`Waiting for ${this.activeTaskCount} active tasks to complete, ${remaining}ms remaining`);
      await new Promise(resolve => setTimeout(resolve, Math.min(checkInterval, remaining)));
      remaining = timeout - (Date.now() - start);
    }
    
    if (this.activeTaskCount > 0) {
      this.logger.warn(`Shutdown timeout reached with ${this.activeTaskCount} tasks still active`);
    } else {
      this.logger.info('All workers completed their tasks');
    }
  }

  /**
   * バックエンドとブローカーの接続を閉じる
   * @private
   */
  private async closeAllConnections(): Promise<void> {
    // バックエンドとブローカーの接続を閉じる
    try {
      if (this.backend) {
        this.logger.info('Disconnecting backend');
        await this.backend.disconnect();
        this.logger.info('Backend disconnected');
      }
    } catch (error) {
      this.logger.error('Error disconnecting backend', error);
      // エラーを投げずに続行するが、ログは残す
    }
    
    try {
      if (this.broker) {
        this.logger.info('Disconnecting broker');
        await this.broker.disconnect();
        this.logger.info('Broker disconnected');
      }
    } catch (error) {
      this.logger.error('Error disconnecting broker', error);
      // エラーを投げずに続行するが、ログは残す
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

/**
 * 複数のタスクを順番に実行する
 * @param tasks - タスク配列
 * @returns 結果配列のAsyncTask
 */
export async function sequence<T>(tasks: ReadonlyArray<AsyncTask<T>>): Promise<AsyncTask<ReadonlyArray<T>>> {
  const sequenceId = `sequence-${uuidv4()}`;
  
  // 空の配列に対しては即座に成功結果を返す
  if (tasks.length === 0) {
    return {
      id: sequenceId,
      promise: async () => [],
      status: async () => 'SUCCESS',
      retry: () => { throw new MitsubaError('Cannot retry empty sequence task'); }
    };
  }

  // 処理結果をキャッシュするための変数
  let executionPromise: Promise<ReadonlyArray<T>> | null = null;
  let cachedStatus: TaskStatus | null = null;

  // 結果を格納するAsyncTask
  const sequenceTask: AsyncTask<ReadonlyArray<T>> = {
    id: sequenceId,
    
    // promise関数は実際の実行を担当
    promise: async () => {
      // 既に実行済みの場合はキャッシュを返す
      if (executionPromise) {
        return executionPromise;
      }

      // 初回実行時は処理を実行してキャッシュ
      executionPromise = tasks.reduce(
        async (resultsPromise, task, index) => {
          // 前のタスクまでの結果配列を取得
          const results = await resultsPromise;
          
          try {
            // 現在のタスクを実行
            const result = await task.promise();
            
            // 結果を配列に追加して返す
            return [...results, result];
          } catch (error) {
            // エラー発生時はステータスを更新
            cachedStatus = 'FAILURE';
            throw error;
          }
        }, 
        Promise.resolve([] as T[])
      ).then(results => {
        // 成功時にステータスを更新
        cachedStatus = 'SUCCESS';
        return results;
      }).catch(error => {
        // エラー発生時はステータスを更新して再スロー
        cachedStatus = 'FAILURE';
        throw error;
      });

      return executionPromise;
    },
    
    // status関数はpromiseのステータスを返す
    status: async () => {
      // ステータスがキャッシュされていればそれを返す
      if (cachedStatus) {
        return cachedStatus;
      }
      
      // まだ実行されていなければ実行してステータスを取得
      try {
        await sequenceTask.promise();
        return 'SUCCESS';
      } catch {
        return 'FAILURE';
      }
    },
    
    // retryはここでは直接サポートしない
    retry: () => { 
      throw new MitsubaError('Cannot retry sequence task directly');
    }
  };

  return sequenceTask;
}

/**
 * 全タスクの完了を待ち、結果をコールバック関数に渡す
 * @param task - タスク配列のAsyncTask
 * @param callback - コールバック関数
 * @returns コールバック結果のAsyncTask
 */
export async function chord<T, R>(task: AsyncTask<ReadonlyArray<T>>, callback?: (results: ReadonlyArray<T>) => R): Promise<AsyncTask<R>> {
  const chordId = `chord-${uuidv4()}`;
  
  // 処理結果をキャッシュするための変数
  let executionPromise: Promise<R> | null = null;
  let cachedStatus: TaskStatus | null = null;
  
  // 結果を格納するAsyncTask
  const chordTask: AsyncTask<R> = {
    id: chordId,
    
    // promise関数は実際の実行を担当
    promise: async () => {
      // 既に実行済みの場合はキャッシュを返す
      if (executionPromise) {
        return executionPromise;
      }
      
      // 初回実行時は処理を実行してキャッシュ
      executionPromise = (async () => {
        try {
          // タスクの結果を取得
          const results = await task.promise();
          
          // コールバック関数を実行
          const result = callback ? callback(results) : (results as unknown as R);
          
          // 成功時にステータスを更新
          cachedStatus = 'SUCCESS';
          return result;
        } catch (error) {
          // エラー発生時はステータスを更新して再スロー
          cachedStatus = 'FAILURE';
          throw error;
        }
      })();
      
      return executionPromise;
    },
    
    // status関数はpromiseのステータスを返す
    status: async () => {
      // ステータスがキャッシュされていればそれを返す
      if (cachedStatus) {
        return cachedStatus;
      }
      
      // まだ実行されていなければ実行してステータスを取得
      try {
        await chordTask.promise();
        return 'SUCCESS';
      } catch {
        return 'FAILURE';
      }
    },
    
    // retryはここでは直接サポートしない
    retry: () => { 
      throw new MitsubaError('Cannot retry chord task directly');
    }
  };

  return chordTask;
}

## 実装の注意点

1. **エラーハンドリング**
   - 接続エラー、タスク実行エラー、再試行ロジックをしっかり実装する
   - ネットワーク切断時の自動再接続機能

2. **パフォーマンス**
   - メッセージングの最適化（バッチ処理、バッファリング）
   - ワーカープールの管理と最適なリソース利用

3. **拡張性**
   - 他のメッセージブローカー（Redis、Amazon SQS）への拡張を容易にする設計
   - プラグインシステムの設計

4. **デバッグとモニタリング**
   - ロギングシステムの実装
   - メトリクス収集とモニタリングツールの統合
   - タスクの進捗と状態の可視化

5. **テスト戦略**
   - ユニットテスト（各コンポーネントの分離テスト）
   - 統合テスト（ブローカーとバックエンドの連携）
   - エンドツーエンドテスト（実際のメッセージ処理フロー）

## 開発ロードマップ

1. **フェーズ1**: コア機能の実装
   - 基本的なタスク定義と実行
   - AMQPブローカーとバックエンドの実装
   - ワーカーの基本実装

2. **フェーズ2**: 高度な機能
   - リトライメカニズム
   - chord/sequenceなどの複合タスク
   - エラーハンドリングの改善

3. **フェーズ3**: 拡張と最適化
   - Redisブローカー実装
   - AmazonSQSブローカー実装
   - パフォーマンス最適化

4. **フェーズ4**: ツールとドキュメント
   - CLIツールの作成
   - 詳細なドキュメント
   - サンプルプロジェクト 