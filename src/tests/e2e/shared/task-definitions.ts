/**
 * Mitsubaの共通E2Eテスト用タスク定義
 * テストとワーカー両方で使用して一貫性を確保する
 */

import {Mitsuba} from '../../..';

export const testTasks = {
  // 基本的なタスク
  addTask: (a: number, b: number) => a + b,

  // 時間のかかる並列実行用タスク
  taskA: async (value: number) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return value * 2;
  },

  taskB: async (value: number) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return value + 10;
  },

  // エラーを発生させるタスク
  errorTask: () => {
    throw new Error('Task failed intentionally');
  },

  // 大量実行用のシンプルなタスク
  incrementTask: (value: number) => value + 1,

  // 以下はワーカー側で使われる可能性のある追加タスク
  multiplyTask: (a: number, b: number) => a * b,

  processString: (str: string, operation: string) => {
    switch (operation) {
      case 'uppercase':
        return str.toUpperCase();
      case 'lowercase':
        return str.toLowerCase();
      case 'reverse':
        return str.split('').reverse().join('');
      default:
        return str;
    }
  },

  delayedTask: async (ms: number, value: string) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `Delayed (${ms}ms): ${value}`;
  },

  // その他の共通タスク
  parseNumber: (str: string) => Number.parseInt(str, 10),
  doubleNumber: (num: number) => num * 2,
  formatResult: (num: number) => `結果: ${num}`,

  // 優先度テスト用タスク
  lowPriorityTask: {
    opts: {priority: 1},
    call: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return 'low priority done';
    },
  },

  highPriorityTask: {
    opts: {priority: 10},
    call: () => 'high priority done',
  },

  // 長時間実行タスク
  longRunningTask: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    return 'completed';
  },

  // 数値計算タスク
  calculate: (a: number, b: number, op: string) => {
    switch (op) {
      case 'add':
        return a + b;
      case 'sub':
        return a - b;
      case 'mul':
        return a * b;
      case 'div':
        return a / b;
      default:
        throw new Error(`Unknown operation: ${op}`);
    }
  },

  // 冪等性テスト用タスク - 状態を持つクロージャの代わりに引数で呼び出し回数を受け取る設計に変更
  firstCallErrorTask: (callCount: number) => {
    if (callCount === 1) {
      throw new Error('初回呼び出しエラー');
    }
    return `成功: ${callCount}回目の呼び出し`;
  },
} as const;

export function createApp(broker: string, backend: string) {
  const app = new Mitsuba('e2e-test-client', {
    broker,
    backend,
    logger: {
      level: 0,
    },
  });
  const {worker, tasks} = app.createTask(testTasks);
  return {app, worker, tasks};
}
