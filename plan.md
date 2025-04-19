# Plan

Celery is a awesome async task queue library which is written by Python.
Mitsuba aims to a port library for TypeScript.

## Concept

1. Typesafety

   Typesafe is a most important thing for the peope who choose TypeScript.

2. Pluggable

   Task queue backend layer is pluggable, so users are able to choose that by their preference.
   So far, amqp protocol (almost equals RabbitMQ) is only supported.

   As next steps, we are going to support Amazon SQS and Redis.

3. Simple

   Mitsuba has to be simple like a Celery does. It's easy to use and maintain.

## Code Example

Simplest example:

```typescript
import {Mitsuba, Task} from 'mitsuba';
import {chord, sequence} from 'mitsuba/functional';
// or any other library
import {pipe} from 'fp-ts/function';

const app = mitsuba(
  'project-name',
  {
    broker='amqp://localhost//',
    backend='amqp://localhost//',
    include=['myproject.tasks'],
    resultExpires=3600,
  }
);

const tasks = app.createTask({
  greetings: () => 'Hello world!',
  add: {
    opts: {priority: 10},
    call: (x: number, y: number) => x + y,
  },
  sum: (...nums: ReadonlyArray<number>) => nums.reduce((s, x) => s + x, 0),

  post: {
    opts: {priority: 10, retryDeley: 30 * 60},
    boundC: (self, token: string, content: string) => {
      try {
        postToSomeOtherService(token, content);
      } catch(e) {
        throw self.retry({cause: e});
      }
    },
  },
  autoRetryPost: {
    opts: {
      priority: 10,
      retryDeley: 30 * 60,
      autoretryFor: [
        // pass instance
        KnownException,
        // or give function
        (e): e is KnownException => true],
    },
    boundC: (self, token: string, content: string) => {
      try {
        postToSomeOtherService(token, content);
      } catch(e) {
        throw self.retry({cause: e});
      }
    },
  },
});

// main
async function main() {
  const greetings = tasks.greetings();
  console.log(await task.promise()); // Hello world!

  const numbers: ReadonlyArray<AsyncTask<number>> = Array(3)
    .keys()
    .map(i => add(1, i));

  // equivalent of sum(chord(sequence(numbers)))
  const result = pipe(
    numbers,
    // `ReadonlyArray<AsyncTask<number>>` -> `AsyncTask<ReadonlyArray<number>>`
    sequence,
    chord,
    sum,
  );
  // 1 + 2 + 3 = 6
  console.log(await result.promise());
}

// should be in other file and other machine
async function worker() {
  await tasks.startWorker();
}
```