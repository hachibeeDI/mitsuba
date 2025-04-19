export type MitsubaApp = {
  /** The unique ID of the Mitsuba app. */
  readonly appId: string;
  /** The name of the Mitsuba app. */
  readonly appName: string;
};

/** Represents the interface for a message broker backend. */
export type BrokerBackend = {
  /** Connects to the broker. */
  connect(): Promise<void>;
  /** Disconnects from the broker. */
  disconnect(): Promise<void>;
  /**
   * Publishes a message to the specified queue.
   * @param queueName The name of the queue to publish to.
   * @param message The message content as a Buffer.
   * @param options Optional publishing options.
   * @returns A promise resolving to true if successful, false otherwise.
   */
  publish(queueName: string, message: Buffer, options?: any): Promise<boolean>;
  // Potentially add methods for consuming tasks (for workers)
};

/** Represents the interface for a result storage backend. */
export type BackendBackend = {
  /** Connects to the result backend. */
  connect(): Promise<void>;
  /** Disconnects from the result backend. */
  disconnect(): Promise<void>;
  /**
   * Stores the result of a task.
   * @param taskId The unique ID of the task.
   * @param result The result data to store.
   * @param expiresIn Optional expiration time in seconds.
   */
  storeResult(taskId: string, result: any, expiresIn?: number): Promise<void>; // expiresIn in seconds
  /**
   * Retrieves the result of a task.
   * @param taskId The unique ID of the task.
   * @returns A promise resolving to the result or null if not found.
   */
  getResult(taskId: string): Promise<any | null>;
  // TODO: Add methods for state tracking?
};

/** Supported broker/backend protocols. */
type SupportedProtocol = 'amqp'; // | 'redis' | 'sqs' | 'kafka' | 'nats' | 'mqtt' | 'ws' | 'wss' | 'ws+json' | 'wss+json' | 'ws+binary' | 'wss+binary' | 'ws+text' | 'wss+text' | 'ws+json-rpc' | 'wss+json-rpc' | 'ws+binary-rpc' | 'wss+binary-rpc' | 'ws+text-rpc' | 'wss+text-rpc';

/** Configuration options for a Mitsuba instance. */
export type MitsubaOptions = {
  /** Connection string for the message broker. */
  broker: `${SupportedProtocol}://${string}`;
  /** Connection string for the result backend. */
  backend: `${SupportedProtocol}://${string}`;
  /** Modules to import tasks from */
  include?: ReadonlyArray<string>;
  /** Default expiration for results in seconds */
  resultExpires?: number;
  /** Default queue for tasks */
  taskQueue?: string;
  /** Add other Celery-like options as needed */
};

/** Represents an asynchronous task result */
export type AsyncTask<T> = {
  /** The unique ID of the task. */
  readonly taskId: string;
  /** Returns a promise that resolves with the task result. */
  promise(): Promise<T>;
  // get(): Promise<T>; // Alias for promise()
  /** Remove result from backend */
  forget(): Promise<void>;
  /** Attempt to cancel task */
  revoke(): Promise<void>;
};

/** Options for configuring a specific task. */
export type TaskOptions = {
  /** Task priority. */
  priority?: number;
  /** Delay in seconds before retrying a failed task. */
  retryDelay?: number; // in seconds
  /** Maximum number of times to retry a failed task. */
  maxRetries?: number;
  /** Specify errors or conditions for which the task should automatically retry. */
  autoretryFor?: ReadonlyArray<ErrorConstructor | ((e: any) => boolean)>;
  /** The queue this task should be sent to. */
  queue?: string;
  // Add other options like time limits, rate limits, etc.
};

/** Structure for defining a task. Can be a simple function, or an object with call/options or boundC/options. */
export type TaskDefinition<C extends (...args: ReadonlyArray<any>) => any = (...args: ReadonlyArray<any>) => any> =
  | C
  | {
      /** The task function to be executed. */
      call: C;
      /** Task-specific options. */
      opts?: TaskOptions;
    }
  | {
      /** A bound task function that receives the BoundTask instance as the first argument. */
      boundC: (self: BoundTask, ...args: Parameters<C>) => ReturnType<C>;
      /** Task-specific options. */
      opts?: TaskOptions;
    };

/** Represents a task instance bound to the Mitsuba app/context. */
export type BoundTask = {
  /** The unique ID of this task instance. */
  readonly taskId: string;
  /** Reference to the Mitsuba app instance. */
  readonly app: MitsubaApp;
  /**
   * Signals that the task should be retried. Throws a special error.
   * @param options Optional retry configuration (cause, delay, maxRetries).
   * @returns An error object to be thrown.
   */
  retry(options?: {cause?: any; delay?: number; maxRetries?: number}): Error; // Throws a special error to signal retry
  // Add other context methods if needed (e.g., update_state)
};

/** Type for the object returned by `createTask`, mapping task names to callable functions that return AsyncTask. */
export type TaskCollection<T extends Record<string, TaskDefinition>> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? /** Callable function representing a simple task. */
      (...args: A) => AsyncTask<R> // Simple function case
    : T[K] extends {call: (...args: infer A) => infer R; opts?: TaskOptions}
      ? /** Callable function representing a task defined with `{ call, opts }`. */
        (...args: A) => AsyncTask<R> // { call, opts } case
      : T[K] extends {boundC: (self: BoundTask, ...args: infer A) => infer R; opts?: TaskOptions}
        ? /** Callable function representing a task defined with `{ boundC, opts }`. */
          (...args: A) => AsyncTask<R> // { boundC, opts } case
        : never;
};
