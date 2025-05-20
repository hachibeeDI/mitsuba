/**
 * SQS ブローカー実装
 */
import {
  SQSClient,
  SendMessageCommand,
  CreateQueueCommand,
  GetQueueUrlCommand,
  type GetQueueUrlCommandOutput,
  type QueueAttributeName,
} from '@aws-sdk/client-sqs';
import {Consumer} from 'sqs-consumer';
import {v4 as uuidv4} from 'uuid';

import {
  type Broker,
  type TaskId,
  type TaskOptions,
  type TaskPayload,
  type TaskHandlerResult,
  isTaskPayload,
  type TaskName,
  type Logger,
} from '../types';
import {BrokerConnectionError, BrokerError} from '../errors';
import {getLogger} from '../logger';
import {jsonSafeParse} from '../helpers';

export type SQSBrokerOptions = {
  /** カスタムエンドポイント */
  endpoint: string;
  /** AWS リージョン */
  region: string;
  /**
   * キュー設定オプション
   */
  queueAttributes?: Partial<Record<QueueAttributeName, string>> | undefined;
  /** バッチサイズ(一度に処理するメッセージ数) */
  batchSize?: number | undefined;
  /** ビジビリティタイムアウト(秒) - 他のコンシューマーから見えなくなる時間 */
  visibilityTimeout?: number | undefined;
  /** 待機時間(秒) - ロングポーリングの待機時間 */
  waitTimeSeconds?: number | undefined;
  /** AWS認証情報 */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
};

async function getOrCreateQueue(
  client: SQSClient,
  queueName: string,
  queueAttributes: SQSBrokerOptions['queueAttributes'],
  logger: Logger,
): Promise<string> {
  try {
    const getResponse = await client.send(
      new GetQueueUrlCommand({
        QueueName: queueName,
      }),
    );
    if (getResponse.QueueUrl) {
      return getResponse.QueueUrl;
    }
  } catch (_getQueueError) {
    logger.info(`Queue ${queueName} not found, creating...`);
  }

  let response: GetQueueUrlCommandOutput;
  try {
    response = await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: queueAttributes,
      }),
    );
  } catch (error) {
    logger.error(`Failed to create queue ${queueName}:`, error);
    throw new BrokerError(`Failed to create queue: ${queueName}`, {cause: error});
  }

  if (!response.QueueUrl) {
    throw new BrokerError(`Failed to create queue: ${queueName}`);
  }
  logger.info(`Created queue ${queueName}`);
  return response.QueueUrl;
}

export class SQSBroker implements Broker {
  private readonly projectName: string;
  private client: SQSClient | null = null;
  private readonly options: SQSBrokerOptions;

  private readonly logger = getLogger();

  /** コンシューマーマップ */
  private consumers = new Map<string, Consumer>();
  /** キューURLキャッシュ */
  private queueUrlCache = new Map<string, string>();

  /**
   * SQSブローカーを初期化
   * @param options - SQSブローカーのオプション
   */
  constructor(projectName: string, options: SQSBrokerOptions) {
    this.projectName = projectName;
    this.options = {
      batchSize: options.batchSize,
      visibilityTimeout: options.visibilityTimeout,
      waitTimeSeconds: options.waitTimeSeconds,

      ...options,

      queueAttributes: {
        DelaySeconds: '0',
        MessageRetentionPeriod: '345600', // 4日間 (秒)
        ...options.queueAttributes,
      },
    };
  }

  /**
   * @throws [BrokerConnectionError] 接続に失敗した場合
   */
  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    this.logger.info(`Connecting to SQS broker at ${this.options.endpoint}`);
    try {
      this.client = new SQSClient(this.options);
    } catch (error) {
      this.logger.error('Failed to connect to SQS broker:', error);
      throw new BrokerConnectionError('Failed to connect to SQS broker', {cause: error});
    }

    // SQSClientの接続テスト - 空のリクエストを送信して接続を確認
    // 接続テストのために何らかのSQS操作を行う
    // たとえば、存在しない可能性のあるキューのURLを取得しようとする
    // エラーになっても接続自体は確立できているかを確認する
    try {
      await this.client.send(new GetQueueUrlCommand({QueueName: `${this.projectName}.test-connection`}));
    } catch (_connectionTestError) {
      // FIXME: エラー内容による分岐が必要
      // キューが存在しないエラーは無視 - 接続自体はOK
      this.logger.debug('Connection test queue not found, but connection established');
    }

    this.logger.info('Successfully connected to SQS broker');
  }

  /**
   */
  async disconnect(): Promise<void> {
    await Promise.allSettled(Array.from(this.consumers.keys()).map((tag) => this.cancelConsumer(tag)));

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    this.queueUrlCache.clear();
  }

  /**
   * タスクをブローカーに発行
   * @param taskId - タスクID
   * @param taskName - タスク名
   * @param args - タスク引数
   * @param options - タスクオプション
   * @returns タスクID
   * @throws ブローカーに接続していない場合
   */
  async publishTask(taskId: TaskId, taskName: TaskName, args: ReadonlyArray<unknown>, options?: TaskOptions): Promise<TaskId> {
    const client = await this.ensureConnection();

    const queueName = `${this.projectName}.${taskName}`;
    const queueUrl = await this.getQueueUrl(queueName);
    const payload: TaskPayload = options ? {id: taskId, taskName, args, options} : {id: taskId, taskName, args};

    try {
      const command = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(payload),
        MessageAttributes: {
          TaskId: {
            DataType: 'String',
            StringValue: taskId,
          },
          TaskName: {
            DataType: 'String',
            StringValue: taskName,
          },
        },
        // 優先度は直接サポートされていないが、メッセージグループIDなどで実装可能
        MessageDeduplicationId: taskId, // 重複排除ID (FIFO キューの場合)
      });

      await client.send(command);
      this.logger.debug(`Published task ${taskId} to queue ${queueName}`);
      return taskId;
    } catch (error) {
      this.logger.error(`Failed to publish task to queue ${queueName}:`, error);
      throw new BrokerError(`Failed to publish task to queue: ${queueName}`, {cause: error});
    }
  }

  /**
   * ブローカーからタスクを消費
   * @param taskName - キュー名
   * @param handler - タスク処理ハンドラー
   * @returns コンシューマータグ
   * @throws ブローカーに接続していない場合
   */
  async consumeTask(taskName: TaskName, handler: (task: TaskPayload) => Promise<TaskHandlerResult>): Promise<string> {
    const client = await this.ensureConnection();

    const queueName = `${this.projectName}.${taskName}`;
    const queueUrl = await this.getQueueUrl(queueName);
    const consumerTag = uuidv4();

    this.logger.debug(`Setting up task consumer for="${taskName}"`);

    const consumer = Consumer.create({
      queueUrl,
      /**
       * @note
       *   Throwing an error (or returning a rejected promise) from the handler function will cause the message to be left on the queue. An SQS redrive policy can be used to move messages that cannot be processed to a dead letter queue.
       *   https://www.npmjs.com/package/sqs-consumer
       */
      handleMessage: async (message) => {
        if (!message.Body) {
          this.logger.warn(`Received message without body from queue ${taskName}`);
          return;
        }

        const content = jsonSafeParse(message.Body);

        if (content.kind === 'failure') {
          this.logger.error('Failed to parse JSON');
          throw new Error('Failed to parse message body as JSON');
        }

        this.logger.info(`Consuming message from ${queueName}: ${JSON.stringify(content.value)}`);

        if (isTaskPayload(content.value) === false) {
          this.logger.error(`Invalid task payload received from queue ${taskName}`);
          throw new Error('Invalid task payload');
        }

        let handlerResult: TaskHandlerResult;
        try {
          handlerResult = await handler(content.value);
        } catch (error) {
          this.logger.error('Error processing task:', error);
          // エラー時はメッセージを削除せず、SQSの再配送メカニズムに任せる
          throw error;
        }

        this.logger.debug(`Task handled result="${JSON.stringify(handlerResult)}"`);

        if (handlerResult.status === 'rejected') {
          this.logger.warn(`Task rejected: ${handlerResult.reason}`);
          // タスク拒否時は、明示的な削除をせず、SQSのデッドレターキューポリシーに任せる
          throw new Error(`Task rejected: ${handlerResult.reason}`);
        }
      },
      // It's true by default, but I'd like to set it explicitly
      shouldDeleteMessages: true,
      sqs: client,
      batchSize: this.options.batchSize || 10,
      visibilityTimeout: this.options.visibilityTimeout || 30,
      waitTimeSeconds: this.options.waitTimeSeconds || 20,
      attributeNames: ['All'],
      messageAttributeNames: ['All'],
    });

    // エラーイベントのハンドリング
    consumer.on('error', (err) => {
      this.logger.error(`Consumer error for queue ${queueName}:`, err);
    });

    consumer.on('processing_error', (err) => {
      this.logger.error(`Processing error for queue ${queueName}:`, err);
    });

    await new Promise<void>((resolve) => {
      consumer.start();
      this.logger.info(`Started consuming from queue ${queueName} with consumer tag ${consumerTag}`);
      // start()は非同期だが、Promiseを返さないため、
      // 一時的にsetTimeoutを使用して非同期処理を表現
      setTimeout(resolve, 0);
    });

    this.consumers.set(consumerTag, consumer);
    return consumerTag;
  }

  /**
   * コンシューマーをキャンセル
   * @param consumerTag - コンシューマータグ
   */
  async cancelConsumer(consumerTag: string): Promise<void> {
    const consumer = this.consumers.get(consumerTag);
    if (!consumer) {
      this.logger.warn(`No consumer found with tag ${consumerTag}`);
      return;
    }

    await new Promise<void>((resolve) => {
      consumer.stop();
      this.logger.info(`Cancelled consumer with tag ${consumerTag}`);
      setTimeout(resolve, 0);
    });
    this.consumers.delete(consumerTag);
  }

  /**
   * キューURLを取得または作成
   * @param queueName - キュー名
   * @returns キューURL
   * @private
   */
  private async getQueueUrl(queueName: string): Promise<string> {
    // キャッシュされたURLがあれば返す
    if (this.queueUrlCache.has(queueName)) {
      const cachedUrl = this.queueUrlCache.get(queueName);
      if (cachedUrl) {
        return cachedUrl;
      }
    }

    const client = await this.ensureConnection();

    const queueUrl = await getOrCreateQueue(client, queueName, this.options.queueAttributes, this.logger);
    this.queueUrlCache.set(queueName, queueUrl);
    return queueUrl;
  }

  /**
   * 接続を確保
   * @private
   */
  private async ensureConnection(): Promise<SQSClient> {
    if (!this.client) {
      await this.connect();
    }
    if (!this.client) {
      throw new BrokerConnectionError('Failed to connect to SQS broker');
    }

    return this.client;
  }
}
