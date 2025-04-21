/**
 * // pooling
 * asEvenly(100)(map(() => checkResult())(infinityVoid()));
 */

export function map<T, U>(fn: (x: T) => U) {
  return function* (xs: Iterable<T>) {
    for (const x of xs) {
      yield fn(x);
    }
  };
}

/** Promise.allの直列版、あるいはfp-tsのTask.sequenceTみたいなもんだとおもいねえ */
export async function* sequencePromise<T>(
  iter: Iterable<Promise<T>>,
): AsyncGenerator<Awaited<T>, void, undefined | (() => Promise<unknown>)> {
  for await (const i of iter) {
    const given = yield i;
    if (given) {
      await given();
    }
  }
}

export function asEvenly(interval: number) {
  return async function* <T>(xs: AsyncIterator<T> | Iterator<T>) {
    while (true) {
      const x = await xs.next();
      if (x.done) {
        return;
      }
      yield x.value;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  };
}

export function* infinityVoid() {
  while (true) {
    yield void 0;
  }
}

type EachPool<R> = {continue: true; v?: undefined} | {continue: false; v: R};
export function pooling<R>(fn: () => EachPool<R>, opts: {interval: number; maxRetry: number; onTimeout?: () => void}): Promise<R> {
  return new Promise((resolve, reject) => {
    const pooling = asEvenly(opts.interval ?? 100)(map(() => fn())(infinityVoid()));

    let retried = 0;
    (async () => {
      for await (const r of pooling) {
        if (retried === (opts?.maxRetry ?? 50)) {
          return reject(new Error('timeout'));
        }
        retried++;

        if (r.continue === false) {
          return resolve(r.v);
        }
      }
    })();
  });
}
