import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../lib/concurrency-limiter.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test('createLimiter rejects a non-positive-integer limit', () => {
  assert.throws(() => createLimiter(0));
  assert.throws(() => createLimiter(-1));
  assert.throws(() => createLimiter(1.5));
});

test('createLimiter runs up to the limit immediately, queues the rest', async () => {
  const run = createLimiter(2);
  let concurrentNow = 0;
  let maxConcurrentSeen = 0;
  const gates = [deferred(), deferred(), deferred()];

  const task = (i) => async () => {
    concurrentNow++;
    maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentNow);
    await gates[i].promise;
    concurrentNow--;
    return i;
  };

  const results = [run(task(0)), run(task(1)), run(task(2))];

  // give the microtask queue a tick so the first two tasks have actually started
  await new Promise((r) => setImmediate(r));
  assert.equal(maxConcurrentSeen, 2, 'only 2 of 3 should have started');

  gates[0].resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(
    maxConcurrentSeen,
    2,
    'the third only starts once a slot frees up',
  );

  gates[1].resolve();
  gates[2].resolve();
  assert.deepEqual(await Promise.all(results), [0, 1, 2]);
});

test('createLimiter propagates rejections without blocking the queue', async () => {
  const run = createLimiter(1);
  const failing = run(async () => {
    throw new Error('boom');
  });
  const succeeding = run(async () => 'ok');

  await assert.rejects(failing, /boom/);
  assert.equal(await succeeding, 'ok');
});

test('createLimiter never runs more than the limit even with many tasks', async () => {
  const limit = 3;
  const run = createLimiter(limit);
  let concurrentNow = 0;
  let maxConcurrentSeen = 0;

  const tasks = Array.from({ length: 20 }, () =>
    run(async () => {
      concurrentNow++;
      maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentNow);
      await new Promise((r) => setTimeout(r, 1));
      concurrentNow--;
    }),
  );

  await Promise.all(tasks);
  assert.ok(
    maxConcurrentSeen <= limit,
    `saw ${maxConcurrentSeen} concurrent, expected <= ${limit}`,
  );
});
