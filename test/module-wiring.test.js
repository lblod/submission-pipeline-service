// Smoke test: the whole module graph resolves and initialises.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('app.js and its full module graph import cleanly', async () => {
  await assert.doesNotReject(import('../app.js'));
});

test('lib/import.js imports cleanly', async () => {
  await assert.doesNotReject(import('../lib/import.js'));
});
