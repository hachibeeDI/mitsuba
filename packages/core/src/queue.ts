import EventEmitter from 'node:events';

/**
 * キュー実装
 * スタックを使用した効率的なキュー実装
 */
export class Queue<T> {
  #stackPush: Array<T> = [];
  #stackPop: Array<T> = [];

  #emitter = new EventEmitter();

  /**
   * 値をキューに追加
   * @param value - キューに追加する値
   */
  enqueue(value: T) {
    this.#stackPush.push(value);
    this.#emitter.emit('enqueue', this);
  }

  /**
   * キューから値を取得
   * @returns キューから取り出した値、キューが空の場合はundefined
   */
  dequeue(): T | undefined {
    if (this.#stackPop.length === 0) {
      while (this.#stackPush.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: this.#stackPush.length > 0で保証
        this.#stackPop.push(this.#stackPush.pop()!);
      }
    }
    return this.#stackPop.pop();
  }

  listen(fn: (thisArgs: typeof this) => void, signal?: AbortSignal) {
    this.#emitter.on('enqueue', fn);

    signal?.addEventListener('abort', () => {
      this.#emitter.removeListener('enqueue', fn);
    });
  }
}
