import {MitsubaOptions, TaskDefinition, TaskOptions} from './interfaces';

/**
 */
export class Queue {
  #stackPush: Array<any> = [];
  #stackPop: Array<any> = [];

  enqueue(value: any) {
    this.#stackPush.push(value);
  }

  dequeue() {
    if (this.#stackPop.length === 0) {
      while (this.#stackPush.length > 0) {
        this.#stackPop.push(this.#stackPush.pop());
      }
    }
    return this.#stackPop.pop();
  }
}
