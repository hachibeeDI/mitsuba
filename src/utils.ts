/**
 * Mitsuba ユーティリティ関数
 */
import {v4 as uuidv4} from 'uuid';
import type {AsyncTask, TaskStatus} from './types';
import {MitsubaError} from './errors';

/**
 * 複数のタスクを順番に実行する
 * @param tasks - タスク配列
 * @returns 結果配列のAsyncTask
 */
export function sequence<T>(tasks: ReadonlyArray<AsyncTask<T>>): AsyncTask<ReadonlyArray<T>> {
  const sequenceId = `sequence-${uuidv4()}`;

  // 空の配列に対しては即座に成功結果を返す
  if (tasks.length === 0) {
    return {
      id: sequenceId,
      promise: async () => [],
      status: async () => 'SUCCESS',
      retry: () => {
        throw new MitsubaError('Cannot retry empty sequence task');
      },
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
      executionPromise = tasks
        .reduce(
          async (resultsPromise, task) => {
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
          Promise.resolve([] as Array<T>),
        )
        .then((results) => {
          // 成功時にステータスを更新
          cachedStatus = 'SUCCESS';
          return results;
        })
        .catch((error) => {
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
  const chordId = `chord-${uuidv4()}`;

  // 処理結果をキャッシュするための変数
  let executionPromise: Promise<R> | null = null;
  let cachedStatus: TaskStatus | null = null;

  // 結果を格納するAsyncTask
  const chordTask: AsyncTask<R> = {
    id: chordId,

    // promise関数は実際の実行を担当
    promise: () => {
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
    },
  };

  return chordTask;
}
