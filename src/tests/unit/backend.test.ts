/**
 * バックエンドモックの単体テスト
 */
import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {MockBackend} from '../mocks/backend.mock';
import {TaskRetrievalError} from '../../errors';
import type {TaskId} from '../../types';

describe('MockBackend 単体テスト', () => {
  let backend: MockBackend;

  // 各テスト前にセットアップを実行
  beforeEach(async () => {
    backend = new MockBackend();
    await backend.connect();
  });

  // 各テスト後にクリーンアップを実行
  afterEach(async () => {
    backend.clearResults();
    await backend.disconnect();
  });

  // 接続状態の確認テスト
  test('接続状態の管理', async () => {
    // 接続済みの状態か確認
    expect(backend.isConnected()).toBe(true);

    // 切断
    await backend.disconnect();
    expect(backend.isConnected()).toBe(false);

    // 再接続
    await backend.connect();
    expect(backend.isConnected()).toBe(true);
  });

  // 結果の保存と取得テスト
  test('結果の保存と取得', async () => {
    // テスト用のタスクIDと結果
    const taskId = 'test-task-id' as TaskId;
    const result = {value: 42, status: 'success'} as const;

    // 結果を保存
    await backend.storeResult(taskId, result);

    // 結果が存在することを確認
    expect(backend.hasResult(taskId)).toBe(true);

    // 結果を取得して検証
    const retrievedResult = await backend.getResult<typeof result>(taskId);
    expect(retrievedResult).toEqual(expect.objectContaining(result));
  });

  // 結果が存在しない場合のエラーテスト
  test('存在しない結果の取得で例外が発生', async () => {
    const nonExistingTaskId = 'non-existing-task' as TaskId;

    // 存在しないタスクIDで取得を試み、失敗状態を確認
    const result = await backend.getResult<unknown>(nonExistingTaskId, 1);
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.error).toBeInstanceOf(TaskRetrievalError);
      expect(result.error.message).toMatch(/non-existing-task/);
    }
  });

  // 結果のクリアテスト
  test('結果のクリア', async () => {
    // テスト用のタスクID1と結果1
    const taskId1 = 'test-task-id-1' as TaskId;
    const result1 = {status: 'success', value: 1} as const;

    // テスト用のタスクID2と結果2
    const taskId2 = 'test-task-id-2' as TaskId;
    const result2 = {status: 'success', value: 2} as const;

    // 複数の結果を保存
    await backend.storeResult(taskId1, result1);
    await backend.storeResult(taskId2, result2);

    // 両方の結果が存在することを確認
    expect(backend.hasResult(taskId1)).toBe(true);
    expect(backend.hasResult(taskId2)).toBe(true);

    // 結果をクリア
    backend.clearResults();

    // どちらの結果も存在しないことを確認
    expect(backend.hasResult(taskId1)).toBe(false);
    expect(backend.hasResult(taskId2)).toBe(false);
  });

  // 直接結果設定テスト
  test('直接結果設定', async () => {
    // テスト用のタスクIDと結果
    const taskId = 'Test-task-id' as TaskId;
    const result = {status: 'success', value: 'whatever'} as const;

    // setResultを使って直接結果を設定
    backend.setResult(taskId, result);

    // 結果が存在することを確認
    expect(backend.hasResult(taskId)).toBe(true);

    // 結果を取得して検証
    const retrievedResult = await backend.getResult<typeof result>(taskId);
    expect(retrievedResult).toEqual(expect.objectContaining(result));
  });

  // 接続していない状態でのエラーハンドリングテスト
  test('未接続状態でのエラーハンドリング', async () => {
    await backend.disconnect();

    // 未接続状態で結果保存するとエラーになるはず
    await expect(() => backend.storeResult('test' as TaskId, {status: 'success', value: 'whatever'})).rejects.toThrowError(
      'Backend is not connected',
    );

    // 未接続状態で結果取得すると失敗結果を返すはず
    const result = await backend.getResult<unknown>('test' as TaskId);
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.error.message).toBe('Backend is not connected');
    }
  });

  // 保存失敗のシミュレーションテスト
  test('保存失敗のシミュレーション', async () => {
    // 保存失敗をシミュレート
    backend.setShouldFailStore(true);

    // 結果保存するとエラーになるはず
    await expect(() => backend.storeResult('test' as TaskId, {status: 'success', value: 'whatever'})).rejects.toThrowError(
      'Failed to store result',
    );

    // 失敗フラグを解除
    backend.setShouldFailStore(false);

    // 正常に保存できるようになるはず
    await backend.storeResult('test' as TaskId, {status: 'success', value: 'whatever'});
    expect(backend.hasResult('test' as TaskId)).toBe(true);
  });

  // 取得失敗のシミュレーションテスト
  test('取得失敗のシミュレーション', async () => {
    // テスト用のタスクIDと結果
    const taskId = 'test-task-id' as TaskId;
    const result = {status: 'success', value: 'test'} as const;

    // 結果を保存
    await backend.storeResult(taskId, result);

    // 取得失敗をシミュレート
    backend.setShouldFailRetrieve(true);

    // 結果取得すると失敗結果を返すはず
    const retrievedResult = await backend.getResult<typeof result>(taskId);
    expect(retrievedResult.status).toBe('failure');
    if (retrievedResult.status === 'failure') {
      expect(retrievedResult.error).toBeInstanceOf(TaskRetrievalError);
    }

    // 失敗フラグを解除
    backend.setShouldFailRetrieve(false);

    // 正常に取得できるようになるはず
    const successResult = await backend.getResult<typeof result>(taskId);
    expect(successResult).toEqual(expect.objectContaining(result));
  });
});
