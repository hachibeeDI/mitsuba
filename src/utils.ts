/**
 * Mitsuba ユーティリティ関数
 */
import {v4 as uuidv4} from 'uuid';
import {unwrapResult, type AsyncTask, type TaskId, type TaskResult} from './types';
import {MitsubaError} from './errors';

export function generateTaskId(prefix = ''): TaskId {
  return `${prefix}${uuidv4()}` as TaskId;
}

/**
 * 複数のタスクを順番に実行する
 * @param tasks - タスク配列
 * @returns 結果配列のAsyncTask
 */
export function sequence<T>(tasks: ReadonlyArray<AsyncTask<T>>): AsyncTask<ReadonlyArray<T>> {
  const taskId = generateTaskId('sequence-');
  // 空の配列に対しては即座に成功結果を返す
  if (tasks.length === 0) {
    return {
      getTaskId: () => Promise.resolve(taskId),
      getResult: async () => ({status: 'success', value: []}),
      get: () => Promise.resolve([]),
      getStatus: () => 'SUCCESS',
      retry: () => {
        throw new MitsubaError('Cannot retry empty sequence task');
      },
    };
  }

  // 処理結果をキャッシュするための変数
  let executionPromise: Promise<TaskResult<ReadonlyArray<T>>> | null = null;
  let _status: 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | 'RETRY' = 'PENDING';

  // 結果を格納するAsyncTask
  const sequenceTask: AsyncTask<ReadonlyArray<T>> = {
    getTaskId: () => Promise.resolve(taskId),

    getStatus: () => _status,

    getResult: () => {
      if (executionPromise) {
        return executionPromise;
      }

      _status = 'STARTED';
      executionPromise = (async () => {
        try {
          const results = await Promise.all(tasks.map((task) => task.get()));

          _status = 'SUCCESS';
          return {status: 'success', value: results};
        } catch (error) {
          _status = 'FAILURE';
          return {
            status: 'failure',
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      })();

      return executionPromise;
    },

    get: () => {
      return unwrapResult(sequenceTask.getResult());
    },

    retry: () => {
      throw new MitsubaError('Cannot retry sequence task directly');
    },
  };

  return sequenceTask;
}

/**
 * 全タスクの完了を待ち、結果をコールバック関数に渡す
 * @param task - タスク配列のAsyncTask
 * @param callback - コールバック関数
 * @returns コールバック結果のAsyncTask
 */
export function chord<T, R>(task: AsyncTask<ReadonlyArray<T>>, callback?: (results: ReadonlyArray<T>) => R): AsyncTask<R> {
  // 処理結果をキャッシュするための変数
  let executionPromise: Promise<TaskResult<R>> | null = null;
  let _status: 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | 'RETRY' = 'PENDING';

  const taskId = generateTaskId('chord-');
  // 結果を格納するAsyncTask
  const chordTask: AsyncTask<R> = {
    getTaskId: () => Promise.resolve(taskId),

    getStatus: () => _status,

    getResult: () => {
      if (executionPromise) {
        return executionPromise;
      }

      _status = 'STARTED';
      executionPromise = (async () => {
        try {
          // タスクの結果を取得
          const taskResult = await task.getResult();

          if (taskResult.status === 'failure') {
            _status = 'FAILURE';
            return {
              status: 'failure',
              error: taskResult.error,
              retryCount: taskResult.retryCount,
            };
          }

          const results = taskResult.value;

          // コールバック関数を実行
          const result = callback ? callback(results) : (results as unknown as R);
          _status = 'SUCCESS';

          return {status: 'success', value: result};
        } catch (error) {
          _status = 'FAILURE';
          return {
            status: 'failure',
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      })();

      return executionPromise;
    },

    get: () => unwrapResult(chordTask.getResult()),
    retry: () => {
      throw new MitsubaError('Cannot retry chord task directly');
    },
  };

  return chordTask;
}
