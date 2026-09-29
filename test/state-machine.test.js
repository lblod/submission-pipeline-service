import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveState,
  detectInconsistencies,
  STATES,
} from '../lib/state-machine.js';
import { TASK_STATUSES } from '../lib/constants.js';

const S = TASK_STATUSES;

function job(tasks) {
  return { jobUri: 'http://example.org/job/1', tasks };
}

test('deriveState: no tasks yet is UNKNOWN', () => {
  assert.equal(deriveState(job([])), STATES.UNKNOWN);
});

test('deriveState: register busy -> REGISTERING', () => {
  assert.equal(
    deriveState(job([{ operation: 'register', status: S.busy }])),
    STATES.REGISTERING,
  );
});

test('deriveState: register success + download scheduled -> SCHEDULED', () => {
  assert.equal(
    deriveState(
      job([
        { operation: 'register', status: S.success },
        { operation: 'download', status: S.scheduled },
      ]),
    ),
    STATES.SCHEDULED,
  );
});

test('deriveState: download busy -> DOWNLOADING', () => {
  assert.equal(
    deriveState(
      job([
        { operation: 'register', status: S.success },
        { operation: 'download', status: S.busy },
      ]),
    ),
    STATES.DOWNLOADING,
  );
});

test('deriveState: download success, import task not created yet -> DOWNLOADED', () => {
  assert.equal(
    deriveState(
      job([
        { operation: 'register', status: S.success },
        { operation: 'download', status: S.success },
      ]),
    ),
    STATES.DOWNLOADED,
  );
});

test('deriveState: download success, import scheduled -> DOWNLOADED', () => {
  assert.equal(
    deriveState(
      job([
        { operation: 'register', status: S.success },
        { operation: 'download', status: S.success },
        { operation: 'import', status: S.scheduled },
      ]),
    ),
    STATES.DOWNLOADED,
  );
});

test('deriveState: import busy -> IMPORTING', () => {
  assert.equal(
    deriveState(
      job([
        { operation: 'register', status: S.success },
        { operation: 'download', status: S.success },
        { operation: 'import', status: S.busy },
      ]),
    ),
    STATES.IMPORTING,
  );
});

test('deriveState: import success -> IMPORTED', () => {
  assert.equal(
    deriveState(
      job([
        { operation: 'register', status: S.success },
        { operation: 'download', status: S.success },
        { operation: 'import', status: S.success },
      ]),
    ),
    STATES.IMPORTED,
  );
});

test('deriveState: any task failed -> FAILED, regardless of the others', () => {
  assert.equal(
    deriveState(
      job([
        { operation: 'register', status: S.success },
        { operation: 'download', status: S.failed },
      ]),
    ),
    STATES.FAILED,
  );
});

test('detectInconsistencies: clean job has no reasons', () => {
  const reasons = detectInconsistencies(
    job([
      { operation: 'register', status: S.success, index: '0' },
      { operation: 'download', status: S.success, index: '1' },
    ]),
  );
  assert.deepEqual(reasons, []);
});

test('detectInconsistencies: duplicate task:index is flagged', () => {
  const reasons = detectInconsistencies(
    job([
      { operation: 'register', status: S.success, index: '0' },
      { operation: 'download', status: S.busy, index: '0' },
    ]),
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /share task:index "0"/);
});

test('detectInconsistencies: stale busy task past the timeout is flagged', () => {
  const now = new Date('2024-01-01T01:00:00Z');
  const modified = new Date('2024-01-01T00:00:00Z'); // 1h idle
  const reasons = detectInconsistencies(
    job([{ operation: 'download', status: S.busy, modified }]),
    { staleTaskTimeoutMs: 30 * 60 * 1000, now }, // 30 min timeout
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /past STALE_TASK_TIMEOUT/);
});

test('detectInconsistencies: busy task within the timeout is not flagged', () => {
  const now = new Date('2024-01-01T00:10:00Z');
  const modified = new Date('2024-01-01T00:00:00Z'); // 10 min idle
  const reasons = detectInconsistencies(
    job([{ operation: 'download', status: S.busy, modified }]),
    { staleTaskTimeoutMs: 30 * 60 * 1000, now },
  );
  assert.deepEqual(reasons, []);
});
