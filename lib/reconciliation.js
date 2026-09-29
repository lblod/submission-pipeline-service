import { sparqlEscapeUri } from 'mu';
import { query, parseResult } from './sparql-helpers.js';
import { PREFIXES, TASK_STATUSES } from './constants.js';
import {
  RECONCILE_ON_BOOT,
  RECONCILE_INTERVAL,
  STALE_TASK_TIMEOUT_HOURS,
  RECONCILE_ABANDON_AFTER_DAYS,
} from './config.js';
import {
  findBusyJobs,
  fetchJobSummary,
  deriveState,
  detectInconsistencies,
  STATES,
} from './state-machine.js';
import { isJobActive, runJobInBackground } from './pipeline.js';
import { performDownload, resumeDownload } from './download.js';
import { calcTimeout } from './download-retry.js';
import { performImport, rollbackPartialImport } from './import.js';
import { getDownloadEventForRemoteDataObject } from './download-queries.js';
import {
  findUnfinishedAttachments,
  resumeAttachmentDownload,
} from './attachments.js';
import { runStatusTransitions } from './task-transitions.js';
import { reportError } from './errors.js';

/**
 * Boot and periodic reconciliation: resumes or fails busy jobs based on their derived
 * state, and resumes unfinished attachment downloads. See README.md "Reconciliation".
 */

/** The task that determines each resumable state. */
const RELEVANT_OPERATION_FOR_STATE = {
  [STATES.REGISTERING]: 'register',
  [STATES.SCHEDULED]: 'download',
  [STATES.DOWNLOADING]: 'download',
  [STATES.DOWNLOADED]: 'import',
  [STATES.IMPORTING]: 'import',
};

let sweepRunning = false;

/**
 * Run one sweep now.
 *
 * @param {object} [options]
 * @param {boolean} [options.ignoreStaleness] true for the boot sweep, where every
 *   busy job is orphaned. Periodic sweeps only touch stale jobs.
 */
export async function runReconciliationSweep({ ignoreStaleness = false } = {}) {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const jobs = await findBusyJobs();
    if (jobs.length) {
      console.log(`Reconciliation sweep: found ${jobs.length} busy job(s)`);
    }
    for (const { jobUri, graph } of jobs) {
      if (isJobActive(jobUri)) continue;
      await reconcileJob(jobUri, graph, ignoreStaleness).catch((error) => {
        console.error(
          `Reconciliation failed for job ${jobUri}: ${error.message}`,
        );
        console.error(error);
      });
    }
    await reconcileAttachments(ignoreStaleness);
  } finally {
    sweepRunning = false;
  }
}

/**
 * Attachments have no task, so they are found by status instead. Those older than
 * RECONCILE_ABANDON_AFTER_DAYS are left alone.
 */
async function reconcileAttachments(ignoreStaleness) {
  const now = Date.now();
  const staleMs = ignoreStaleness
    ? 0
    : STALE_TASK_TIMEOUT_HOURS * 60 * 60 * 1000;
  const attachments = await findUnfinishedAttachments({
    createdAfter: new Date(
      now - RECONCILE_ABANDON_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ),
    createdBefore: new Date(now - staleMs),
  });
  for (const { remoteDataObjectUri, graph } of attachments) {
    await resumeAttachmentDownload(remoteDataObjectUri, graph).catch(
      (error) => {
        console.error(
          `Reconciliation failed for attachment ${remoteDataObjectUri}: ${error.message}`,
        );
      },
    );
  }
}

/** Resumed work runs in the background, so a sweep never waits for a download. */
async function reconcileJob(jobUri, graph, ignoreStaleness) {
  const summary = await fetchJobSummary(jobUri, graph);
  const state = deriveState(summary);

  // Applies to the boot sweep too.
  if (RELEVANT_OPERATION_FOR_STATE[state] && isTooOldToResume(summary)) {
    return abandonOldJob(summary, state);
  }

  if (!ignoreStaleness && !(await isStaleEnoughToTouch(summary, state))) {
    return;
  }

  if (RELEVANT_OPERATION_FOR_STATE[state]) {
    await reportInconsistencies(summary, ignoreStaleness);
    console.log(`Reconciling job ${jobUri}, currently ${state}`);
  }
  switch (state) {
    case STATES.REGISTERING:
      return failOrphanedRegistration(summary);
    case STATES.SCHEDULED:
      return runJobInBackground(jobUri, () => reEnqueueDownload(summary));
    case STATES.DOWNLOADING:
      return runJobInBackground(jobUri, () => resumeStuckDownload(summary));
    case STATES.DOWNLOADED:
      return runJobInBackground(jobUri, () => runPendingImport(summary));
    case STATES.IMPORTING:
      return runJobInBackground(jobUri, () => rollbackAndRerunImport(summary));
    default:
      return; // IMPORTED, FAILED, UNKNOWN: nothing to do
  }
}

/** Reported only when reconciliation acts on a job, so each problem is reported once. */
async function reportInconsistencies(summary, atStartup) {
  // At startup every busy task was interrupted by the restart, which is expected.
  const inconsistencies = detectInconsistencies(summary, {
    staleTaskTimeoutMs: atStartup
      ? undefined
      : STALE_TASK_TIMEOUT_HOURS * 60 * 60 * 1000,
  });
  if (!inconsistencies.length) return;
  console.warn(
    `Job ${summary.jobUri} flagged INCONSISTENT: ${inconsistencies.join('; ')}`,
  );
  await reportError({
    message: `Submission job ${summary.jobUri} is INCONSISTENT.`,
    detail: inconsistencies.join('\n'),
    reference: summary.jobUri,
  });
}

/**
 * A job is stale once its relevant task has been idle for STALE_TASK_TIMEOUT_HOURS.
 *
 * A download can legitimately sit idle for up to a day between retries, so for
 * DOWNLOADING the deadline is the download event's `dct:modified` plus the expected
 * backoff plus STALE_TASK_TIMEOUT_HOURS. Resuming earlier would start a second,
 * concurrent download.
 */
async function isStaleEnoughToTouch(summary, state) {
  if (state === STATES.DOWNLOADING) {
    return isDownloadEventStale(summary);
  }
  const relevantOperation = RELEVANT_OPERATION_FOR_STATE[state];
  const task = summary.tasks.find((t) => t.operation === relevantOperation);
  if (!task?.modified) return true;
  const idleMs = Date.now() - task.modified.getTime();
  return idleMs > STALE_TASK_TIMEOUT_HOURS * 60 * 60 * 1000;
}

async function isDownloadEventStale(summary) {
  const downloadTask = summary.tasks.find((t) => t.operation === 'download');
  const found = await findRemoteDataObjectForDownloadTask(
    downloadTask.uri,
    summary.graph,
  );
  if (!found) return true;
  const event = await getDownloadEventForRemoteDataObject(found.rdo);
  if (!event?.modified) return true;
  const expectedWaitMs = calcTimeout(event.numberOfRetries);
  const graceMs = STALE_TASK_TIMEOUT_HOURS * 60 * 60 * 1000;
  const deadline = event.modified.getTime() + expectedWaitMs + graceMs;
  return Date.now() > deadline;
}

function isTooOldToResume(summary) {
  if (!summary.created) return false;
  const ageMs = Date.now() - summary.created.getTime();
  return ageMs > RECONCILE_ABANDON_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/** Fail a job that is too old to resume, leaving the decision to an operator. */
async function abandonOldJob(summary, state) {
  const relevantOperation = RELEVANT_OPERATION_FOR_STATE[state];
  const task = summary.tasks.find((t) => t.operation === relevantOperation);
  if (!task) return;
  const ageDays = Math.round(
    (Date.now() - summary.created.getTime()) / (24 * 60 * 60 * 1000),
  );
  const errorUri = await reportError({
    message: `Submission job ${summary.jobUri} was abandoned by reconciliation instead of being auto-resumed: it was registered ${ageDays} day(s) ago, past RECONCILE_ABANDON_AFTER_DAYS. It was found stuck at ${state}. If this submission is still wanted, it needs manual review and a fresh resubmission, not an automatic retry.`,
  });
  console.warn(
    `Abandoning job ${summary.jobUri} (age ${ageDays}d, state ${state}) instead of resuming it`,
  );
  await runStatusTransitions([
    {
      graph: summary.graph,
      subject: task.uri,
      newStatus: TASK_STATUSES.failed,
      extraInsert: `${sparqlEscapeUri(task.uri)} task:error ${sparqlEscapeUri(errorUri)} .`,
    },
    {
      graph: summary.graph,
      subject: summary.jobUri,
      newStatus: TASK_STATUSES.failed,
      extraInsert: `${sparqlEscapeUri(summary.jobUri)} task:error ${sparqlEscapeUri(errorUri)} .`,
    },
  ]);
}

async function failOrphanedRegistration(summary) {
  const registerTask = summary.tasks.find((t) => t.operation === 'register');
  if (!registerTask) return;
  const errorUri = await reportError({
    message: `Submission registration for job ${summary.jobUri} was interrupted by a service restart and cannot be resumed (the original HTTP request is gone). The vendor must resubmit.`,
  });
  await runStatusTransitions([
    {
      graph: summary.graph,
      subject: registerTask.uri,
      newStatus: TASK_STATUSES.failed,
      extraInsert: `${sparqlEscapeUri(registerTask.uri)} task:error ${sparqlEscapeUri(errorUri)} .`,
    },
    {
      graph: summary.graph,
      subject: summary.jobUri,
      newStatus: TASK_STATUSES.failed,
      extraInsert: `${sparqlEscapeUri(summary.jobUri)} task:error ${sparqlEscapeUri(errorUri)} .`,
    },
  ]);
}

/** The remote data object and URL in a download task's input container. */
async function findRemoteDataObjectForDownloadTask(downloadTaskUri, graph) {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?rdo ?url WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(downloadTaskUri)}
          task:inputContainer ?container .
        ?container task:hasHarvestingCollection ?collection .
        ?collection dct:hasPart ?rdo .
        ?rdo nie:url ?url .
      }
    }
  `);
  return parseResult(result)[0];
}

/** The remote data object in an import task's input container. */
async function findRemoteDataObjectForImportTask(importTaskUri, graph) {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?rdo WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(importTaskUri)} task:inputContainer ?container .
        ?container task:hasFile ?rdo .
      }
    }
  `);
  return parseResult(result)[0]?.rdo;
}

async function reEnqueueDownload(summary) {
  const downloadTask = summary.tasks.find((t) => t.operation === 'download');
  const found = await findRemoteDataObjectForDownloadTask(
    downloadTask.uri,
    summary.graph,
  );
  if (!found) {
    console.error(
      `Could not find the remote data object for download task ${downloadTask.uri}`,
    );
    return;
  }
  const { importTaskUri } = await performDownload({
    jobUri: summary.jobUri,
    downloadTaskUri: downloadTask.uri,
    remoteDataObjectUri: found.rdo,
    submissionGraph: summary.graph,
    url: found.url,
  });
  await runImport(summary, importTaskUri, found.rdo);
}

async function resumeStuckDownload(summary) {
  const downloadTask = summary.tasks.find((t) => t.operation === 'download');
  const found = await findRemoteDataObjectForDownloadTask(
    downloadTask.uri,
    summary.graph,
  );
  if (!found) {
    console.error(
      `Could not find the remote data object for download task ${downloadTask.uri}`,
    );
    return;
  }
  const { rdo: remoteDataObjectUri, url } = found;
  const event = await getDownloadEventForRemoteDataObject(remoteDataObjectUri);

  const params = {
    jobUri: summary.jobUri,
    downloadTaskUri: downloadTask.uri,
    remoteDataObjectUri,
    submissionGraph: summary.graph,
    url,
  };
  let importTaskUri;
  if (event) {
    ({ importTaskUri } = await resumeDownload({
      ...params,
      downloadEventUri: event.downloadEventUri,
      retryCount: event.numberOfRetries,
    }));
  } else {
    // A busy task without a download event starts over rather than staying stuck.
    ({ importTaskUri } = await performDownload(params));
  }
  await runImport(summary, importTaskUri, remoteDataObjectUri);
}

async function runPendingImport(summary) {
  const importTask = summary.tasks.find((t) => t.operation === 'import');
  const remoteDataObjectUri = await findRemoteDataObjectForImportTask(
    importTask.uri,
    summary.graph,
  );
  if (!remoteDataObjectUri) {
    console.error(
      `Could not find the remote data object for import task ${importTask.uri}`,
    );
    return;
  }
  await runImport(summary, importTask.uri, remoteDataObjectUri);
}

async function runImport(summary, importTaskUri, remoteDataObjectUri) {
  await performImport({
    jobUri: summary.jobUri,
    importTaskUri,
    remoteDataObjectUri,
    submissionGraph: summary.graph,
  });
}

async function rollbackAndRerunImport(summary) {
  const importTask = summary.tasks.find((t) => t.operation === 'import');
  const remoteDataObjectUri = await findRemoteDataObjectForImportTask(
    importTask.uri,
    summary.graph,
  );
  if (!remoteDataObjectUri) {
    console.error(
      `Could not find the remote data object for import task ${importTask.uri}`,
    );
    return;
  }
  await rollbackPartialImport(remoteDataObjectUri, summary.graph);
  await runImport(summary, importTask.uri, remoteDataObjectUri);
}

let periodicHandle;

/**
 * Run the boot sweep (RECONCILE_ON_BOOT) and schedule periodic sweeps
 * (RECONCILE_INTERVAL).
 */
export function startReconciliation() {
  if (RECONCILE_ON_BOOT) {
    runReconciliationSweep({ ignoreStaleness: true }).catch((error) => {
      console.error(`Boot reconciliation sweep failed: ${error.message}`);
      console.error(error);
    });
  }

  if (RECONCILE_INTERVAL > 0) {
    periodicHandle = setInterval(() => {
      runReconciliationSweep({ ignoreStaleness: false }).catch((error) => {
        console.error(`Periodic reconciliation sweep failed: ${error.message}`);
        console.error(error);
      });
    }, RECONCILE_INTERVAL * 1000);
    periodicHandle.unref();
  }
}

/** For tests / graceful shutdown. */
export function stopReconciliation() {
  clearInterval(periodicHandle);
}
