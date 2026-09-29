import { DOWNLOAD_CONCURRENCY } from './config.js';

/**
 * Minimal bounded-concurrency queue: at most `maxConcurrent` functions run at once,
 * the rest wait in FIFO order. Bounds work within this process only.
 *
 * @param {number} maxConcurrent
 * @returns {(fn: () => Promise<any>) => Promise<any>} `run` -- call with a function
 *   that starts the work when invoked; resolves/rejects exactly as that function's
 *   own promise does, once a slot is free.
 */
export function createLimiter(maxConcurrent) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(
      `createLimiter requires a positive integer, got ${maxConcurrent}`,
    );
  }

  let active = 0;
  const queue = [];

  function runNext() {
    if (active >= maxConcurrent || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

/**
 * Shared limit on download attempts and imports, for new submissions, reconciliation
 * and attachments alike. Work holding a slot must never wait for another slot.
 */
export const limitBackgroundWork = createLimiter(DOWNLOAD_CONCURRENCY);
