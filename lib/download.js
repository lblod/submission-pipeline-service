import {
  uuid,
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeDateTime,
} from 'mu';
import fs from 'fs-extra';
import mime from 'mime-types';
import { TASK_STATUSES, JOB_PREFIX } from './constants.js';
import {
  DEFAULT_GRAPH,
  REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD,
} from './config.js';
import { buildStatusTransitionQuery } from './task-transitions.js';
import {
  startDownload,
  createPhysicalFileDataObject,
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
    onSuccess: (downloadResult) =>
      finishSuccess(params, downloadEventUri, downloadResult),
    onFailure: (error) => finishFailure(params, downloadEventUri, error),
  });
}

/** Creates the physical file's own resource and returns its URI. */
async function associateCachedFile(
  downloadResult,
  remoteDataObjectUri,
  submissionGraph,
) {
  const physicalUri = `share://${downloadResult.physicalFileName}`;
  const { size } = await fs.stat(downloadResult.physicalPath);
  await createPhysicalFileDataObject({
    physicalUri,
    dataSourceUri: remoteDataObjectUri,
    graph: submissionGraph,
    name: downloadResult.logicalFileName,
    format: mime.lookup(downloadResult.extension) || downloadResult.contentType,
    fileSize: size,
    extension: downloadResult.extension,
    created: Date.now(),
  });
  return physicalUri;
}

async function finishSuccess(context, downloadEventUri, downloadResult) {
  const { jobUri, downloadTaskUri, remoteDataObjectUri, submissionGraph } =
    context;
  const physicalFileUri = await associateCachedFile(
    downloadResult,
    remoteDataObjectUri,
    submissionGraph,
  );

  const resultContainerId = uuid();
  // Schedule the import task ourselves; job-controller-service only takes over after
  // tasko:import.
  const importTaskId = uuid();
  const importTaskUri = JOB_PREFIX.concat(importTaskId);
  const importInputContainerId = uuid();
  const nowSparql = sparqlEscapeDateTime(new Date());
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
        task:inputContainer asj:${importInputContainerId} .
      asj:${importInputContainerId}
        a nfo:DataContainer ;
        mu:uuid ${sparqlEscapeString(importInputContainerId)} ;
        task:hasFile ${sparqlEscapeUri(remoteDataObjectUri)} .
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
  const taskTransitionQuery = buildStatusTransitionQuery({
    graph: submissionGraph,
    subject: downloadTaskUri,
    newStatus: TASK_STATUSES.failed,
    extraInsert: `${sparqlEscapeUri(downloadTaskUri)} task:error ${sparqlEscapeUri(errorUri)} .`,
  });
  const jobTransitionQuery = buildStatusTransitionQuery({
    graph: submissionGraph,
    subject: jobUri,
    newStatus: TASK_STATUSES.failed,
    extraInsert: `${sparqlEscapeUri(jobUri)} task:error ${sparqlEscapeUri(errorUri)} .`,
  });
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
