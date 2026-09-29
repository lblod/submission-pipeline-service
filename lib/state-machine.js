import { sparqlEscapeUri } from 'mu';
import { query, parseResult } from './sparql-helpers.js';
import {
  PREFIXES,
  TASK_STATUSES,
  TASK_OPERATIONS,
  JOB_OPERATIONS,
} from './constants.js';

/**
 * Derives a submission's pipeline state from its job's task statuses. The state is
 * never stored, so it works for jobs created by the old services too. See README.md
 * "Submission state machine".
 *
 * `deriveState` and `detectInconsistencies` are pure; `fetchJobSummary` does the I/O.
 */

export const STATES = Object.freeze({
  REGISTERING: 'REGISTERING',
  SCHEDULED: 'SCHEDULED',
  DOWNLOADING: 'DOWNLOADING',
  DOWNLOADED: 'DOWNLOADED',
  IMPORTING: 'IMPORTING',
  IMPORTED: 'IMPORTED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

const OPERATION_URI_TO_NAME = Object.fromEntries(
  Object.entries(TASK_OPERATIONS).map(([name, uri]) => [uri, name]),
);

/**
 * @typedef {object} TaskSummary
 * @property {string} uri
 * @property {'register'|'download'|'import'} operation
 * @property {string} status one of the js: task status values
 * @property {Date} [modified]
 * @property {string} [index] the task:index literal, for duplicate-index detection
 */

/**
 * @typedef {object} JobSummary
 * @property {string} jobUri
 * @property {string} graph the submission graph this job lives in
 * @property {string} [jobStatus] one of the js: task status values
 * @property {Date} [created] when the job was created
 * @property {TaskSummary[]} tasks
 */

/**
 * Derive the submission's pipeline state from a job's task statuses alone.
 *
 * @param {JobSummary} job
 * @returns {string} one of STATES
 */
export function deriveState(job) {
  const byOperation = Object.fromEntries(
    (job.tasks || []).map((t) => [t.operation, t]),
  );
  const register = byOperation.register;
  const download = byOperation.download;
  const importTask = byOperation.import;

  if (
    [register, download, importTask].some(
      (t) => t?.status === TASK_STATUSES.failed,
    )
  ) {
    return STATES.FAILED;
  }

  if (importTask?.status === TASK_STATUSES.success) return STATES.IMPORTED;
  if (importTask?.status === TASK_STATUSES.busy) return STATES.IMPORTING;

  if (download?.status === TASK_STATUSES.success) {
    // tasko:import absent or js:scheduled, per README's state table
    if (!importTask || importTask.status === TASK_STATUSES.scheduled) {
      return STATES.DOWNLOADED;
    }
  }

  if (download?.status === TASK_STATUSES.busy) return STATES.DOWNLOADING;

  if (
    register?.status === TASK_STATUSES.success &&
    download?.status === TASK_STATUSES.scheduled
  ) {
    return STATES.SCHEDULED;
  }

  if (register?.status === TASK_STATUSES.busy) return STATES.REGISTERING;

  return STATES.UNKNOWN;
}

/**
 * Reasons why a job's triples look inconsistent; empty if they don't.
 *
 * @param {JobSummary} job
 * @param {object} extra
 * @param {number} [extra.staleTaskTimeoutMs] see STALE_TASK_TIMEOUT_HOURS env var
 * @param {Date} [extra.now] injectable for tests; defaults to `new Date()`
 * @returns {string[]}
 */
export function detectInconsistencies(job, extra = {}) {
  const now = extra.now || new Date();
  const reasons = [];
  const tasks = job.tasks || [];

  const indexCounts = new Map();
  for (const t of tasks) {
    if (t.index === undefined) continue;
    indexCounts.set(t.index, (indexCounts.get(t.index) || 0) + 1);
  }
  for (const [index, count] of indexCounts) {
    if (count > 1) reasons.push(`${count} tasks share task:index "${index}"`);
  }

  if (extra.staleTaskTimeoutMs !== undefined) {
    for (const t of tasks) {
      if (t.status === TASK_STATUSES.busy && t.modified) {
        const idleMs = now.getTime() - t.modified.getTime();
        if (idleMs > extra.staleTaskTimeoutMs) {
          reasons.push(
            `${t.operation} task has been js:busy for ${Math.round(idleMs / 1000)}s, ` +
              'past STALE_TASK_TIMEOUT_HOURS',
          );
        }
      }
    }
  }

  return reasons;
}

/**
 * Fetch the task/job triples for one job and shape them into a JobSummary for
 * `deriveState`/`detectInconsistencies`.
 *
 * @param {string} jobUri
 * @param {string} graph the submission graph this job lives in (from `findBusyJobs`,
 *   or known upfront by whoever just created the job)
 * @returns {Promise<JobSummary>}
 */
export async function fetchJobSummary(jobUri, graph) {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?jobStatus ?jobCreated ?task ?operation ?taskStatus ?modified ?index WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(jobUri)} adms:status ?jobStatus ; dct:created ?jobCreated .
        OPTIONAL {
          ?task
            dct:isPartOf ${sparqlEscapeUri(jobUri)} ;
            task:operation ?operation ;
            adms:status ?taskStatus ;
            dct:modified ?modified .
          OPTIONAL { ?task task:index ?index . }
        }
      }
    }
  `);
  const rows = parseResult(result);
  const jobStatus = rows[0]?.jobStatus;
  const created = rows[0]?.jobCreated;
  const tasks = rows
    .filter((r) => r.task)
    .map((r) => ({
      uri: r.task,
      operation: OPERATION_URI_TO_NAME[r.operation] || r.operation,
      status: r.taskStatus,
      modified: r.modified,
      index: r.index,
    }));
  return { jobUri, graph, jobStatus, created, tasks };
}

/**
 * Every automatic submission job at `js:busy` whose import hasn't succeeded yet,
 * across all organisation graphs. Jobs past the import belong to
 * job-controller-service.
 *
 * @returns {Promise<Array<{jobUri: string, graph: string}>>}
 */
export async function findBusyJobs() {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?job ?g WHERE {
      GRAPH ?g {
        ?job
          a cogs:Job ;
          task:operation ${sparqlEscapeUri(JOB_OPERATIONS.automaticSubmissionFlow)} ;
          adms:status js:busy .
        FILTER NOT EXISTS {
          ?importTask
            dct:isPartOf ?job ;
            task:operation ${sparqlEscapeUri(TASK_OPERATIONS.import)} ;
            adms:status js:success .
        }
      }
    }
  `);
  return parseResult(result).map((r) => ({ jobUri: r.job, graph: r.g }));
}
