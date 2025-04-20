/**
 * AMQP バックエンド実装
 */
import type {Channel, ChannelModel} from 'amqplib';
import {connect} from 'amqplib';

import type {Backend, TaskId} from '../types';
import {BackendConnectionError, TaskRetrievalError, TaskTimeoutError} from '../errors';
import {getLogger} from '../logger';

export class AMQPBackend implements Backend {
  /** AMQPコネクション */
  private connection: ChannelModel | null = null;
  /** AMQPチャネル */
  private channel: Channel | null = null;
  /** バックエンドURL */
  private url: string;
  /** 結果交換機名 */
  private resultExchange = 'mitsuba.results';
  /** ロガー */
  private readonly logger = getLogger();

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
    if (this.connection && this.channel) {
      return; // 既に接続済み
    }

    try {
      this.connection = await connect(this.url);

      if (!this.connection) {
        throw new BackendConnectionError('Failed to create connection');
      }

      this.channel = await this.connection.createChannel();

      if (!this.channel) {
        throw new BackendConnectionError('Failed to create channel');
      }

      // 結果交換機を定義（direct型）
      await this.channel.assertExchange(this.resultExchange, 'direct', {durable: true});

      // 接続エラーイベントハンドラ
      this.connection.on('error', (err) => {
        this.logger.error('AMQP connection error:', err);
        this.cleanupConnection();
      });

      // チャネルエラーイベントハンドラ
      this.channel.on('error', (err) => {
        this.logger.error('AMQP channel error:', err);
      });

      // 接続クローズイベントハンドラ
      this.connection.on('close', () => {
        this.logger.warn('AMQP connection closed');
        this.cleanupConnection();
      });
    } catch (error) {
      this.cleanupConnection();
      throw new BackendConnectionError('Failed to establish connection', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * バックエンドとの接続を切断
   */
  async disconnect(): Promise<void> {
    // チャネルクローズ
    if (this.channel) {
      try {
        await this.channel.close();
      } catch (error) {
        this.logger.error('Error closing AMQP channel:', error);
        // エラーは飲み込んで接続クローズを続行
      } finally {
        this.channel = null;
      }
    }

    // 接続クローズ
    if (this.connection) {
      try {
        await this.connection.close();
      } catch (error) {
        this.logger.error('Error closing AMQP connection:', error);
        // エラーは飲み込んで続行
      } finally {
        this.connection = null;
      }
    }
  }

  /**
   * タスク結果をバックエンドに保存
   * @param taskId - タスクID
   * @param result - タスク結果
   * @param expiresIn - 結果の有効期限（秒）
   * @throws バックエンドに接続していない場合
   */
  async storeResult(taskId: TaskId, result: unknown, expiresIn = 3600): Promise<void> {
    await this.ensureConnection();

    if (!this.channel) {
      throw new BackendConnectionError('Channel is not connected');
    }

    const payload = {
      taskId,
      result,
      timestamp: Date.now(),
      expires: Date.now() + expiresIn * 1000,
    };

    const success = this.channel.publish(this.resultExchange, taskId, Buffer.from(JSON.stringify(payload)), {
      expiration: String(expiresIn * 1000),
    });

    if (!success) {
      throw new Error(`Failed to publish result for task: ${taskId}`);
    }
  }

  /**
   * バックエンドからタスク結果を取得
   * @param taskId - タスクID
   * @returns タスク結果
   * @throws バックエンドに接続していない場合またはタイムアウト
   */
  async getResult<T>(taskId: TaskId, timeoutMs = 30000): Promise<T> {
    await this.ensureConnection();

    if (!this.channel) {
      throw new BackendConnectionError('Channel is not connected');
    }

    // 一時的なキューを作成（排他的、自動削除）
    const queueResult = await this.channel.assertQueue('', {
      exclusive: true,
      autoDelete: true,
    });

    if (!queueResult || !queueResult.queue) {
      throw new BackendConnectionError('Failed to create queue for result retrieval');
    }

    const queue = queueResult.queue;

    return new Promise<T>((resolve, reject) => {
      // タイムアウト処理
      const timeout = setTimeout(() => {
        cleanup();
        reject(new TaskTimeoutError(taskId, timeoutMs));
      }, timeoutMs);

      // 結果メッセージのコンシューマー
      let consumerTag = '';
      const startConsumer = async () => {
        try {
          if (!this.channel) {
            throw new BackendConnectionError('Channel is not connected');
          }

          const consumer = await this.channel.consume(
            queue,
            (msg) => {
              if (!msg) {
                return; // キャンセル通知の場合
              }

              try {
                // メッセージの内容をパース
                const content = JSON.parse(msg.content.toString());

                // メッセージを確認応答
                if (this.channel) {
                  this.channel.ack(msg);
                }

                // 成功したらタイムアウトをクリアしてキューをアンバインド
                clearTimeout(timeout);
                cleanup();

                // 結果を返す
                resolve(content.result as T);
              } catch (error) {
                cleanup();
                reject(
                  new TaskRetrievalError(taskId, {
                    cause: error instanceof Error ? error : new Error(String(error)),
                  }),
                );
              }
            },
            {noAck: false},
          );

          if (consumer) {
            consumerTag = consumer.consumerTag;
          }
        } catch (error) {
          cleanup();
          reject(
            new TaskRetrievalError(taskId, {
              cause: error instanceof Error ? error : new Error(String(error)),
            }),
          );
        }
      };

      // キューのバインド
      const bindQueue = async () => {
        try {
          if (!this.channel) {
            throw new BackendConnectionError('Channel is not connected');
          }

          await this.channel.bindQueue(queue, this.resultExchange, taskId);
          await startConsumer();
        } catch (error) {
          cleanup();
          reject(
            new TaskRetrievalError(taskId, {
              cause: error instanceof Error ? error : new Error(String(error)),
            }),
          );
        }
      };

      // クリーンアップ関数
      const cleanup = () => {
        try {
          if (consumerTag && this.channel) {
            // コンシューマーキャンセル（エラーは無視）
            this.channel.cancel(consumerTag).catch((err) => {
              this.logger.error('Error canceling consumer:', err);
            });
          }

          if (this.channel) {
            // キューのアンバインド（エラーは無視）
            this.channel.unbindQueue(queue, this.resultExchange, taskId).catch((err) => {
              this.logger.error('Error unbinding queue:', err);
            });
          }
        } catch (error) {
          this.logger.error('Error during cleanup:', error);
          // エラーは飲み込む
        }
      };

      // バインドとコンシューマー開始
      bindQueue().catch((err) => {
        clearTimeout(timeout);
        reject(new TaskRetrievalError(taskId, {cause: err}));
      });
    });
  }

  /**
   * 接続状態を確認し、必要に応じて再接続
   * @private
   */
  private async ensureConnection(): Promise<void> {
    if (!this.channel || !this.connection) {
      await this.connect();
    }
  }

  /**
   * 接続をクリーンアップする
   * @private
   */
  private cleanupConnection(): void {
    this.channel = null;
    this.connection = null;
  }
}
