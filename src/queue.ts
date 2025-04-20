/**
 * キュー実装
 * スタックを使用した効率的なキュー実装
 */
export class Queue {
  #stackPush: Array<any> = [];
  #stackPop: Array<any> = [];

  /**
   * 値をキューに追加
   * @param value - キューに追加する値
   */
  enqueue(value: any) {
    this.#stackPush.push(value);
  }

  /**
   * キューから値を取得
   * @returns キューから取り出した値、キューが空の場合はundefined
   */
  dequeue() {
    if (this.#stackPop.length === 0) {
      while (this.#stackPush.length > 0) {
        this.#stackPop.push(this.#stackPush.pop());
      }
    }
    return this.#stackPop.pop();
  }
}
