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

function globalOptionToTaskOption(_globalOption: MitsubaOptions): TaskOptions {
  return {};
}


export function definitionAsTaskWorker<Args extends ReadonlyArray<any>, R>(
  taskName: string,
  definition: TaskDefinition<any, any>,
  options: MitsubaOptions,
) {
  return (...args: any) => {
      if (typeof definition === 'function') {
        return (...args: any) => this.executeTask(false, taskName, args, definition, globalOptionToTaskOption(options));
      }
      if ('call' in definition) {
        return (...args: any) => this.executeTask(false, taskName, args, definition.call, definition.opts);
      }
      if ('boundC' in definition) {
        return (...args: any) => this.executeTask(true, taskName, args, definition.boundC, definition.opts);
      }
  };
}
