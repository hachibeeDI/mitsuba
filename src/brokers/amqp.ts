/**
 * AMQP ブローカー実装
 */
import type {Channel, ChannelModel, Options, Replies} from 'amqplib';
import {connect} from 'amqplib';

import {v4 as uuidv4} from 'uuid';
import type {BrokerInterface, TaskOptions, TaskPayload} from '../types';
import {BrokerConnectionError, BrokerError} from '../errors';
import {getLogger} from '../logger';

export type AMQPBrokerOptions = {
  /** AMQPサーバーURI */
  url?: string;
  /** 接続オプション */
  connectionOptions?: Options.Connect;
  /** キュー設定オプション */
  queueOptions?: Options.AssertQueue;
  /** メッセージ設定オプション */
  messageOptions?: Options.Publish;
  /** プリフェッチ数 */
  prefetch?: number;
};

export class AMQPBroker implements BrokerInterface {
  /** AMQPコネクション */
  private connection: ChannelModel | null = null;
  /** AMQPチャネル */
  private channel: Channel | null = null;
  /** ブローカーURL */
  private readonly url: string;
  /** コンシューマータグマップ */
  private consumers = new Map<string, Replies.Consume>();
  private readonly connectionOptions: Options.Connect;
  private readonly queueOptions: Options.AssertQueue;
  private readonly messageOptions: Options.Publish;
  private readonly prefetch: number;
  private readonly logger = getLogger();

  /**
   * AMQPブローカーを初期化
   * @param options - AMQPブローカーのオプション
   */
  constructor(options: AMQPBrokerOptions = {}) {
    this.url = options.url ?? 'amqp://localhost';
    this.connectionOptions = options.connectionOptions ?? {};
    this.queueOptions = {
      durable: true,
      ...options.queueOptions,
    };
    this.messageOptions = {
      persistent: true,
      ...options.messageOptions,
    };
    this.prefetch = options.prefetch ?? 1;
  }

  /**
   * ブローカーに接続
   * @throws 接続に失敗した場合
   */
  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }

    try {
      this.logger.info(`Connecting to AMQP broker at ${this.url}`);
      this.connection = await connect(this.url, this.connectionOptions);

      if (!this.connection) {
        throw new BrokerError('Failed to create connection');
      }

      this.connection.on('error', (err) => {
        this.logger.error('AMQP connection error:', err);
      });

      this.connection.on('close', () => {
        this.logger.info('AMQP connection closed');
        this.connection = null;
        this.channel = null;
      });

      this.channel = await this.connection.createChannel();

      if (!this.channel) {
        throw new BrokerError('Failed to create channel');
      }

      await this.channel.prefetch(this.prefetch);

      this.logger.info('Successfully connected to AMQP broker');
    } catch (error) {
      this.logger.error('Failed to connect to AMQP broker:', error);
      throw new BrokerError('Failed to connect to AMQP broker', {cause: error});
    }
  }

  /**
   * ブローカーとの接続を切断
   */
  async disconnect(): Promise<void> {
    if (this.consumers.size > 0) {
      await Promise.allSettled(
        Array.from(this.consumers.values()).map((consumer) => {
          if ('consumerTag' in consumer) {
            return this.cancelConsumer(consumer.consumerTag);
          }
          return Promise.resolve();
        }),
      );
      this.consumers.clear();
    }

    if (this.channel) {
      try {
        await this.channel.close();
      } catch (_error) {
        // すでに閉じられている場合は無視
      }
      this.channel = null;
    }

    if (this.connection) {
      try {
        await this.connection.close();
      } catch (_error) {
        // すでに閉じられている場合は無視
      }
      this.connection = null;
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
    await this.ensureConnection();

    const taskId = uuidv4();
    const payload: TaskPayload = {
      id: taskId,
      taskName,
      args,
      options: options ? {...options} : undefined,
    };

    if (!this.channel) {
      throw new BrokerConnectionError('Channel is not connected');
    }

    // キューの確保
    await this.channel.assertQueue(taskName, this.queueOptions);

    // メッセージの発行
    const priority = options?.priority ?? 0;
    const success = this.channel.sendToQueue(taskName, Buffer.from(JSON.stringify(payload)), {
      ...this.messageOptions,
      priority,
      messageId: taskId,
    });

    if (!success) {
      throw new Error(`Failed to publish task to queue: ${taskName}`);
    }

    this.logger.debug(`Published task ${taskId} to queue ${taskName}`);
    return taskId;
  }

  /**
   * ブローカーからタスクを消費
   * @param queueName - キュー名
   * @param handler - タスク処理ハンドラー
   * @returns コンシューマータグ
   * @throws ブローカーに接続していない場合
   */
  async consumeTask(queueName: string, handler: (task: unknown) => Promise<unknown>): Promise<string> {
    await this.ensureConnection();

    if (!this.channel) {
      throw new BrokerConnectionError('Channel is not connected');
    }

    // キューの確保
    await this.channel.assertQueue(queueName, this.queueOptions);

    // コンシューマーを設定
    const consumeReply = await this.channel.consume(
      queueName,
      async (msg) => {
        if (!msg) {
          this.logger.warn(`Received null message from queue ${queueName}`);
          return; // キャンセル通知の場合はスキップ
        }

        try {
          // メッセージをJSONとしてパース
          const content = JSON.parse(msg.content.toString());

          // ハンドラーを呼び出し
          await handler(content);

          // 正常処理完了後ACK
          if (this.channel) {
            this.channel.ack(msg);
          }
        } catch (error) {
          this.logger.error('Error processing task:', error);

          // 処理エラー時は再キューイング
          // メッセージヘッダーで再試行回数を追跡可能
          if (this.channel) {
            this.channel.nack(msg, false, false);
          }
        }
      },
      {noAck: false},
    );

    if (!consumeReply || !consumeReply.consumerTag) {
      throw new Error(`Failed to consume from queue: ${queueName}`);
    }

    this.consumers.set(queueName, consumeReply);
    this.logger.debug(`Started consuming from queue ${queueName} with consumer tag ${consumeReply.consumerTag}`);
    return consumeReply.consumerTag;
  }

  /**
   * コンシューマーをキャンセル
   * @param consumerTag - コンシューマータグ
   */
  async cancelConsumer(consumerTag: string): Promise<void> {
    await this.ensureConnection();

    if (!this.channel) {
      throw new BrokerConnectionError('Channel is not connected');
    }

    if (!this.consumers.has(consumerTag)) {
      this.logger.warn(`Consumer with tag ${consumerTag} not found`);
      return;
    }

    try {
      // コンシューマーをキャンセル
      await this.channel.cancel(consumerTag);

      // マップから削除
      this.consumers.delete(consumerTag);
      this.logger.debug(`Cancelled consumer with tag ${consumerTag}`);
    } catch (error) {
      this.logger.error('Failed to cancel consumer:', error);
      throw new BrokerError(`Failed to cancel consumer with tag ${consumerTag}`, {cause: error});
    }
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
}
