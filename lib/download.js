import {
  uuid,
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeDateTime,
} from 'mu';
import { PREFIXES, TASK_STATUSES, JOB_PREFIX } from './constants.js';
import { update } from './sparql-helpers.js';
import {
  DEFAULT_GRAPH,
  REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD,
} from './config.js';
import {
  buildStatusTransitionQuery,
  buildFailureTransitions,
} from './task-transitions.js';
import {
  startDownload,
  completeDownloadSuccess,
  completeDownloadFailure,
  getAuthenticationConfiguration,
} from './download-queries.js';
import { runDownloadWithRetry } from './download-retry.js';
import { limitBackgroundWork } from './concurrency-limiter.js';
import { cleanCredentials } from './credentials.js';
import { reportError } from './errors.js';

/**
 * The download step, with the download task and job bookkeeping. See README.md
 * "Step 2 — download".
 *
 * Resolves only once the download succeeds or runs out of retries, which can take
 * days. Never await it on a request path.
 *
 * @param {object} params
 * @param {string} params.jobUri
 * @param {string} params.downloadTaskUri
 * @param {string} params.remoteDataObjectUri
 * @param {string} params.submissionGraph
 * @param {string} params.url the publication URL to download (nie:url)
 * @param {string} [params.suggestedFilename]
 * @returns {Promise<{physicalFileUri: string, importTaskUri: string}>}
 */
export async function performDownload(params) {
  const { downloadTaskUri, remoteDataObjectUri, submissionGraph } = params;

  const taskBusyQuery = buildStatusTransitionQuery({
    graph: submissionGraph,
    subject: downloadTaskUri,
    newStatus: TASK_STATUSES.busy,
  });
  const downloadEventUri = await limitBackgroundWork(() =>
    startDownload({
      downloadTaskTransitionQuery: taskBusyQuery,
      graph: submissionGraph,
      remoteDataObjectUri,
      defaultGraph: DEFAULT_GRAPH,
    }),
  );

  return resumeDownload({ ...params, downloadEventUri, retryCount: 0 });
}

/**
 * Continue a download from an existing `ndo:DownloadEvent` and retry count, leaving
 * the task and remote data object statuses as they are. Used by lib/reconciliation.js
 * to resume an interrupted download.
 *
 * @param {object} params same as `performDownload`, plus:
 * @param {string} params.downloadEventUri
 * @param {number} params.retryCount
 * @returns {Promise<{physicalFileUri: string, importTaskUri: string}>}
 */
export async function resumeDownload(params) {
  const { downloadEventUri } = params;
  return runDownloadWithRetry({
    ...params,
    onSuccess: (physicalFileUri) =>
      finishSuccess(params, downloadEventUri, physicalFileUri),
    onFailure: (error) => finishFailure(params, downloadEventUri, error),
  });
}

/**
 * The triples of a scheduled import task for a downloaded publication. We schedule it
 * ourselves; job-controller-service only takes over after tasko:import.
 *
 * @returns {{importTaskUri: string, triples: string}}
 */
function buildImportTask({ jobUri, downloadTaskUri, remoteDataObjectUri }) {
  const importTaskId = uuid();
  const inputContainerId = uuid();
  const nowSparql = sparqlEscapeDateTime(new Date());
  return {
    importTaskUri: JOB_PREFIX.concat(importTaskId),
    triples: `
      asj:${importTaskId}
        a task:Task ;
        mu:uuid ${sparqlEscapeString(importTaskId)} ;
        adms:status js:scheduled ;
        dct:created ${nowSparql} ;
        dct:modified ${nowSparql} ;
        task:cogsOperation cogs:TransformationProcess ;
        task:operation tasko:import ;
        dct:creator services:automatic-submission-service ;
        task:index "2" ;
        dct:isPartOf ${sparqlEscapeUri(jobUri)} ;
        cogs:dependsOn ${sparqlEscapeUri(downloadTaskUri)} ;
        task:inputContainer asj:${inputContainerId} .
      asj:${inputContainerId}
        a nfo:DataContainer ;
        mu:uuid ${sparqlEscapeString(inputContainerId)} ;
        task:hasFile ${sparqlEscapeUri(remoteDataObjectUri)} .
    `,
  };
}

/**
 * Schedule the import task of a successful download that has none. Used by
 * lib/reconciliation.js for jobs downloaded by the old services, where
 * job-controller-service created the import task.
 *
 * @param {object} params
 * @param {string} params.jobUri
 * @param {string} params.downloadTaskUri
 * @param {string} params.remoteDataObjectUri
 * @param {string} params.submissionGraph
 * @returns {Promise<string>} the new import task's URI
 */
export async function scheduleImportTask({ submissionGraph, ...params }) {
  const { importTaskUri, triples } = buildImportTask(params);
  await update(`
    ${PREFIXES}
    INSERT DATA {
      GRAPH ${sparqlEscapeUri(submissionGraph)} {
        ${triples}
      }
    }
  `);
  return importTaskUri;
}

async function finishSuccess(context, downloadEventUri, physicalFileUri) {
  const { jobUri, downloadTaskUri, remoteDataObjectUri, submissionGraph } =
    context;

  const resultContainerId = uuid();
  const { importTaskUri, triples: importTaskTriples } = buildImportTask({
    jobUri,
    downloadTaskUri,
    remoteDataObjectUri,
  });
  const taskTransitionQuery = buildStatusTransitionQuery({
    graph: submissionGraph,
    subject: downloadTaskUri,
    newStatus: TASK_STATUSES.success,
    extraInsert: `
      ${sparqlEscapeUri(downloadTaskUri)} task:resultsContainer asj:${resultContainerId} .
      asj:${resultContainerId}
        a nfo:DataContainer ;
        mu:uuid ${sparqlEscapeString(resultContainerId)} ;
        task:hasFile ${sparqlEscapeUri(remoteDataObjectUri)} .
      ${importTaskTriples}
    `,
  });
  await completeDownloadSuccess({
    graph: submissionGraph,
    defaultGraph: DEFAULT_GRAPH,
    remoteDataObjectUri,
    physicalFileUri,
    downloadEventUri,
    taskTransitionQuery,
  });
  await cleanUpCredentialsIfConfigured(remoteDataObjectUri, submissionGraph);
  console.log(
    `Download of ${remoteDataObjectUri} succeeded (job ${jobUri}), file ${physicalFileUri}`,
  );
  return { physicalFileUri, importTaskUri };
}

async function finishFailure(context, downloadEventUri, error) {
  const { jobUri, downloadTaskUri, remoteDataObjectUri, submissionGraph } =
    context;
  const errorUri = await reportError({
    message: `Download failed permanently for remote data object ${remoteDataObjectUri}. This is monitored via task ${downloadTaskUri}.`,
    detail: error.message,
  });
  const [taskTransitionQuery, jobTransitionQuery] = buildFailureTransitions({
    graph: submissionGraph,
    taskUri: downloadTaskUri,
    jobUri,
    errorUri,
  }).map(buildStatusTransitionQuery);
  await completeDownloadFailure({
    graph: submissionGraph,
    defaultGraph: DEFAULT_GRAPH,
    remoteDataObjectUri,
    downloadEventUri,
    taskTransitionQuery,
    jobTransitionQuery,
  });
  await cleanUpCredentialsIfConfigured(remoteDataObjectUri, submissionGraph);
  const err = new Error(
    `Download of ${remoteDataObjectUri} failed permanently: ${error.message}`,
  );
  err.alreadyStoredError = true;
  throw err;
}

async function cleanUpCredentialsIfConfigured(
  remoteDataObjectUri,
  submissionGraph,
) {
  if (!REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD) return;
  const authConf = await getAuthenticationConfiguration(
    remoteDataObjectUri,
    submissionGraph,
  );
  if (authConf) await cleanCredentials(authConf);
}
