# Mitsuba

Celery inspired task queue system for TypeScript.

## Concept

1. Typesafety

   Typesafe is a most important thing for the peope who choose TypeScript.

2. Pluggable

   Task queue backend layer is pluggable, so users are able to choose that by their preference.
   So far, amqp protocol and Amazon SQS is supported.

   As next steps, we are going to support Redis.

3. Simple

   Mitsuba has to be simple like a Celery does. It's easy to use and maintain.

## Code Example

You should deploy your RabbitMQ server first.

### Task definition

```typescript
// app.ts
import {mitsuba, Task} from 'mitsuba';

const app = mitsuba(
  'project-name',
  {
    broker: 'amqp://localhost//',
    backend: 'amqp://localhost//',
  }
);

const {worker, tasks} = app.createTask({
  greetings: () => 'Hello world!',
  add: {
    opts: {priority: 10},
    call: (x: number, y: number) => x + y,
  },
  sum: (...nums: ReadonlyArray<number>) => nums.reduce((s, x) => s + x, 0),
});

export {worker, tasks, app};
```

### Deploy worker

```typescript
// worker.ts
import {app, worker} from './app';

async function startWorker() {
  const {app, worker} = createApp(RABBITMQ_URL, RABBITMQ_URL);
  await app.init();
  await worker.start();

  process.on('SIGTERM', async () => {
    await worker.stop();
    await app.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await worker.stop();
    await app.close();
    process.exit(0);
  });

  process.on('uncaughtException', async (error) => {
    await worker.stop();
    await app.close();
    process.exit(1);
  });
}

startWorker();
```

Then you can start your worker via commands like `npx ts-node ./worker.ts`.


### Emit task

Now you can distribute your task execution to your workers.

```typescript
// main.ts
import {app, tasks} from './app';

async function main() {
  await app.init();
  const greetings = tasks.greetings();
  console.log(await greetings.get()); // Hello world!
}
```


## Todo

- [x] SQS broker Support
- [ ] Redis backend Support
- [ ] Auto retry
- [ ] mono repo

