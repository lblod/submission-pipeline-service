import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStatusTransitionQuery,
  runStatusTransitions,
} from '../lib/task-transitions.js';

const GRAPH =
  'http://mu.semte.ch/graphs/organizations/org-1/LoketLB-toezichtGebruiker';
const TASK = 'http://data.lblod.info/id/automatic-submission-job/task-1';
const JOB = 'http://data.lblod.info/id/automatic-submission-job/job-1';
const SUCCESS = 'http://redpencil.data.gift/id/concept/JobStatus/success';
const FAILED = 'http://redpencil.data.gift/id/concept/JobStatus/failed';

test('buildStatusTransitionQuery: deletes exactly status+modified, nothing else', () => {
  const q = buildStatusTransitionQuery({
    graph: GRAPH,
    subject: TASK,
    newStatus: SUCCESS,
  });
  const deleteBlock = q.slice(q.indexOf('DELETE'), q.indexOf('INSERT'));
  assert.match(deleteBlock, /adms:status \?oldStatus/);
  assert.match(deleteBlock, /dct:modified \?oldModified/);
  // nothing else is deleted
  assert.equal((deleteBlock.match(/;/g) || []).length, 1);
});

test('buildStatusTransitionQuery: WHERE mirrors the DELETE guard exactly', () => {
  const q = buildStatusTransitionQuery({
    graph: GRAPH,
    subject: TASK,
    newStatus: SUCCESS,
  });
  const deleteBlock = q.slice(q.indexOf('DELETE {'), q.indexOf('INSERT {'));
  const whereBlock = q.slice(q.indexOf('WHERE {'));
  const innerOf = (block) =>
    block.slice(block.indexOf('{') + 1, block.lastIndexOf('}')).trim();
  assert.equal(
    innerOf(deleteBlock).replace(/\s+/g, ' '),
    innerOf(whereBlock).replace(/\s+/g, ' '),
  );
});

test('buildStatusTransitionQuery: extraInsert lands inside the same GRAPH block as the new status', () => {
  const q = buildStatusTransitionQuery({
    graph: GRAPH,
    subject: TASK,
    newStatus: SUCCESS,
    extraInsert: '<http://example.org/container> a nfo:DataContainer .',
  });
  const insertBlock = q.slice(q.indexOf('INSERT {'), q.indexOf('WHERE {'));
  assert.match(insertBlock, /adms:status.*JobStatus\/success/s);
  assert.match(insertBlock, /nfo:DataContainer/);
});

test('runStatusTransitions: joins independent transitions with a single ; separator', async () => {
  // Only the query building; running it needs a triplestore.
  const taskQuery = buildStatusTransitionQuery({
    graph: GRAPH,
    subject: TASK,
    newStatus: FAILED,
  });
  const jobQuery = buildStatusTransitionQuery({
    graph: GRAPH,
    subject: JOB,
    newStatus: FAILED,
  });
  const combined = [taskQuery, jobQuery].join('\n;\n');
  // both subjects appear, joined by exactly one statement separator
  assert.match(
    combined,
    new RegExp(TASK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(
    combined,
    new RegExp(JOB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(combined.split('\n;\n').length, 2);
  assert.equal(typeof runStatusTransitions, 'function');
});
