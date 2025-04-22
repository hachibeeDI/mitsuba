/**
 * AMQP バックエンド実装
 */
import type {Channel, ChannelModel} from 'amqplib';
import {connect} from 'amqplib';

import type {Backend, TaskId, TaskResult} from '../types';
import {BackendConnectionError, TaskRetrievalError, TaskTimeoutError} from '../errors';
import {getLogger} from '../logger';
import {jsonSafeParse} from '../helpers';
import {AssertionError} from 'node:assert';

type ChannelPayload = {
  taskId: TaskId;
  result: TaskResult<unknown>;
  timestamp: number;
  expires: number;
};

function isChannelPayload(payload: unknown): payload is ChannelPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'taskId' in payload &&
    'result' in payload &&
    'timestamp' in payload &&
    'expires' in payload
  );
}

export class AMQPBackend implements Backend {
  /** AMQPコネクション */
  private connection: ChannelModel | null = null;
  /** AMQPチャネル */
  private channel: Channel | null = null;
  private url: string;
  private projectName: string;
  private readonly logger = getLogger();

  /**
   * AMQPバックエンドを初期化
   * @param url - AMQPバックエンドのURL
   */
  constructor(url: string, projectName: string) {
    this.url = url;
    this.projectName = projectName;
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
      this.channel = await this.connection.createChannel();

      // 結果交換機を定義（direct型）
      await this.channel.assertExchange(this.projectName, 'direct', {durable: true});
    } catch (error) {
      this.cleanupConnection();
      throw new BackendConnectionError('Failed to establish connection', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    this.connection.on('error', (err) => {
      this.logger.error('AMQP connection error:', err);
      this.cleanupConnection();
    });

    this.channel.on('error', (err) => {
      this.logger.error('AMQP channel error:', err);
    });

    this.connection.on('close', () => {
      this.logger.warn('AMQP connection closed');
      this.cleanupConnection();
    });
  }

  /**
   * タスク結果をバックエンドに保存
   * @param taskId - タスクID
   * @param result - タスク結果
   * @param expiresIn - 結果の有効期限（秒）
   * @throws バックエンドに接続していない場合
   */
  async storeResult(taskId: TaskId, result: TaskResult<unknown>, expiresIn = 3600): Promise<void> {
    await this.ensureConnection();

    if (!this.channel) {
      throw new BackendConnectionError('Channel is not connected');
    }

    const payload = {
      taskId,
      result,
      timestamp: Date.now(),
      expires: Date.now() + expiresIn * 1000,
    } satisfies ChannelPayload;

    const success = this.channel.publish(
      this.projectName,
      taskId,
      Buffer.from(JSON.stringify(payload)),
      {
        expiration: String(expiresIn * 1000),
      },
    );

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
  async getResult<T>(taskId: TaskId, timeoutMs = 30000): Promise<TaskResult<T>> {
    await this.ensureConnection();
    if (!this.channel) {
      throw new BackendConnectionError('Channel is not connected');
    }

    // 一時的なキューを作成（排他的、自動削除）
    const {queue} = await this.channel.assertQueue('', {
      exclusive: true,
      autoDelete: true,
    });
    await this.channel.bindQueue(queue, this.projectName, taskId);

    return new Promise<TaskResult<T>>((resolve, reject) => {
      let consumerTag = '';
      const cleanup = () => {
        if (consumerTag && this.channel) {
          this.channel.cancel(consumerTag).catch((err) => {
            this.logger.error('Error canceling consumer:', err);
          });
        }

        this.channel
          ?.unbindQueue(queue, this.projectName, taskId)
          ?.catch((err) => {
            this.logger.error('Error unbinding queue:', err);
          });
      };

      const timeout = setTimeout(() => {
        cleanup();
        const error = new TaskTimeoutError(taskId, timeoutMs);
        resolve({status: 'failure', error});
      }, timeoutMs);

      const startConsumer = async () => {
        if (!this.channel) {
          const error = new BackendConnectionError('Channel is not connected');
          resolve({status: 'failure', error});
          return;
        }

        this.logger.debug(`consumer started for taskId=${taskId}`);

        const consumer = await this.channel.consume(
          queue,
          (msg) => {
            if (!msg) {
              return; // キャンセル通知の場合
            }

            const msgContent = msg.content.toString();
            this.logger.debug(`consumer started for taskId=${taskId}`);
            const content = jsonSafeParse(msgContent);
            if (content.kind === 'failure') {
              return reject(new AssertionError({message: 'Malformed JSON received', actual: msgContent}));
            }
            if (!isChannelPayload(content.value)) {
              return reject(new AssertionError({message: 'Invalid payload', actual: content.value}));
            }

            this.channel?.ack(msg);

            clearTimeout(timeout);
            cleanup();

            resolve({status: 'success', value: content.value.result as T});
          },
          {noAck: false},
        );

        if (consumer) {
          consumerTag = consumer.consumerTag;
        }
      };

      startConsumer().catch((err) => {
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

  /**
   * バックエンドとの接続を切断
   */
  async disconnect(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch (error) {
      this.logger.error('Error closing AMQP channel:', error);
    } finally {
      this.cleanupConnection();
    }
  }
}
