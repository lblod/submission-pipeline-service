import {
  uuid,
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeDateTime,
} from 'mu';
import { JSDOM } from 'jsdom';
import { query, update, parseResult } from './sparql-helpers.js';
import { PREFIXES, DOWNLOAD_STATUSES, CREATORS } from './constants.js';
import {
  VANDENBROELE_URI,
  APPLY_VANDENBROELE_FILENAME_WORKAROUND,
  REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD,
  DEFAULT_GRAPH,
} from './config.js';
import {
  cloneAuthenticationConfiguration,
  cleanCredentials,
} from './credentials.js';
import {
  startDownload,
  completeDownloadSuccess,
  completeDownloadFailure,
  getAuthenticationConfiguration,
  createPhysicalFileDataObject,
  getDownloadEventForRemoteDataObject,
} from './download-queries.js';
import { runDownloadWithRetry } from './download-retry.js';
import { limitBackgroundWork } from './concurrency-limiter.js';
import { reportError } from './errors.js';
import fs from 'fs-extra';
import mime from 'mime-types';

/**
 * Attachments are scheduled during the import step and downloaded in the background,
 * with the same retry loop as the publication. They have no task:Task, and a failing
 * attachment never fails the import.
 */

async function isProvidedByVandenbroele(submission, graph) {
  const result = await query(`
    ${PREFIXES}
    ASK {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(submission)} pav:providedBy ${sparqlEscapeUri(VANDENBROELE_URI)} .
      }
    }`);
  return result.boolean;
}

/**
 * Guess an attachment's filename from the anchor text linking to it, for a vendor
 * (Vandenbroele) that doesn't send one.
 */
function guesstimateVandenbroeleFilename(html, remoteFile) {
  const dom = new JSDOM(html);
  const anchors = dom.window.document.querySelectorAll(
    `a[href="${remoteFile}"]`,
  );
  for (const anchor of anchors) {
    if (anchor.children.length > 0) continue;
    const text = anchor.textContent.trim();
    if (!text) continue;
    const parts = text.split('.');
    if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
      return text;
    }
  }
  return '';
}

/**
 * The attachment remote data objects that already exist for a submission, per URL.
 * Only an interrupted import that is being re-run finds any.
 *
 * @returns {Promise<Map<string, string[]>>}
 */
export async function findExistingAttachments(submission, graph) {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?remoteDataObject ?url WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(submission)} nie:hasPart ?remoteDataObject .
        ?remoteDataObject
          a nfo:RemoteDataObject ;
          dct:creator ${sparqlEscapeUri(CREATORS.importSubmission)} ;
          nie:url ?url .
      }
    }
    ORDER BY ?remoteDataObject
  `);
  const byUrl = new Map();
  for (const { remoteDataObject, url } of parseResult(result)) {
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(remoteDataObject);
  }
  return byUrl;
}

/**
 * Create an attachment's remote data object with cloned credentials and link it to
 * the submission. Does not start the download.
 *
 * @param {object} params
 * @param {string} params.submission
 * @param {string} params.attachmentUrl
 * @param {string} params.submissionGraph
 * @param {string} [params.html] the submission's own HTML, for the Vandenbroele
 *   filename workaround
 * @returns {Promise<{remoteDataObjectUri: string, url: string,
 *   suggestedFilename?: string}>} input for `dispatchAttachmentDownload`
 */
export async function scheduleAttachment({
  submission,
  attachmentUrl,
  submissionGraph,
  html,
}) {
  const remoteDataId = uuid();
  const remoteDataUri = `http://data.lblod.info/id/remote-data-objects/${remoteDataId}`;
  const nowSparql = sparqlEscapeDateTime(new Date());

  let suggestedFilename;
  if (
    APPLY_VANDENBROELE_FILENAME_WORKAROUND &&
    html &&
    (await isProvidedByVandenbroele(submission, submissionGraph))
  ) {
    suggestedFilename =
      guesstimateVandenbroeleFilename(html, attachmentUrl) || undefined;
  }

  const clonedAuthConf = await cloneAuthenticationConfiguration({
    targetUri: remoteDataUri,
    sourceUri: submission,
    graph: submissionGraph,
  });

  try {
    await update(`
      ${PREFIXES}
      INSERT DATA {
        GRAPH ${sparqlEscapeUri(submissionGraph)} {
          ${sparqlEscapeUri(remoteDataUri)}
            a nfo:RemoteDataObject, nfo:FileDataObject ;
            mu:uuid ${sparqlEscapeString(remoteDataId)} ;
            nie:url ${sparqlEscapeUri(attachmentUrl)} ;
            dct:creator ${sparqlEscapeUri(CREATORS.importSubmission)} ;
            adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.readyToBeCached)} ;
            ${suggestedFilename ? `ext:suggestedFilename ${sparqlEscapeString(suggestedFilename)} ;` : ''}
            dct:created ${nowSparql} ;
            dct:modified ${nowSparql} .
          ${sparqlEscapeUri(submission)} nie:hasPart ${sparqlEscapeUri(remoteDataUri)} .
        }
      }
    `);
    return {
      remoteDataObjectUri: remoteDataUri,
      url: attachmentUrl,
      suggestedFilename,
    };
  } catch (e) {
    if (clonedAuthConf?.newAuthConf)
      await cleanCredentials(clonedAuthConf.newAuthConf);
    throw e;
  }
}

const activeDownloads = new Set();

/**
 * Download an attachment in the background, continuing from `downloadEvent` if
 * given. Does nothing if this process is already downloading it. Errors are logged,
 * never thrown.
 *
 * @param {object} params
 * @param {string} params.remoteDataObjectUri
 * @param {string} params.url
 * @param {string} [params.suggestedFilename]
 * @param {string} params.submissionGraph
 * @param {{downloadEventUri: string, numberOfRetries: number}} [params.downloadEvent]
 */
export function dispatchAttachmentDownload(params) {
  const { remoteDataObjectUri } = params;
  if (activeDownloads.has(remoteDataObjectUri)) return;
  activeDownloads.add(remoteDataObjectUri);
  downloadAttachment(params)
    .catch((error) => {
      console.error(
        `Attachment download failed for ${remoteDataObjectUri}: ${error.message}`,
      );
    })
    .finally(() => activeDownloads.delete(remoteDataObjectUri));
}

/**
 * Resume the download of an attachment that was interrupted, e.g. by a restart.
 * Does nothing if it has finished or this process is still downloading it.
 *
 * @param {string} remoteDataObjectUri
 * @param {string} submissionGraph
 */
export async function resumeAttachmentDownload(
  remoteDataObjectUri,
  submissionGraph,
) {
  if (activeDownloads.has(remoteDataObjectUri)) return;
  const result = await query(`
    ${PREFIXES}
    SELECT ?url ?suggestedFilename WHERE {
      GRAPH ${sparqlEscapeUri(submissionGraph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)} nie:url ?url ; adms:status ?status .
        VALUES ?status {
          ${sparqlEscapeUri(DOWNLOAD_STATUSES.readyToBeCached)}
          ${sparqlEscapeUri(DOWNLOAD_STATUSES.ongoing)}
        }
        OPTIONAL {
          ${sparqlEscapeUri(remoteDataObjectUri)} ext:suggestedFilename ?suggestedFilename .
        }
      }
    }
  `);
  const attachment = parseResult(result)[0];
  if (!attachment) return;
  const downloadEvent =
    await getDownloadEventForRemoteDataObject(remoteDataObjectUri);
  console.log(`Resuming attachment download ${remoteDataObjectUri}`);
  dispatchAttachmentDownload({
    remoteDataObjectUri,
    url: attachment.url,
    suggestedFilename: attachment.suggestedFilename,
    submissionGraph,
    downloadEvent,
  });
}

/**
 * Unfinished attachments created between `createdAfter` and `createdBefore`, across
 * all organisation graphs.
 *
 * @returns {Promise<Array<{remoteDataObjectUri: string, graph: string}>>}
 */
export async function findUnfinishedAttachments({
  createdAfter,
  createdBefore,
}) {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?remoteDataObject ?g WHERE {
      GRAPH ?g {
        ?remoteDataObject
          a nfo:RemoteDataObject ;
          dct:creator ${sparqlEscapeUri(CREATORS.importSubmission)} ;
          adms:status ?status ;
          dct:created ?created .
        VALUES ?status {
          ${sparqlEscapeUri(DOWNLOAD_STATUSES.readyToBeCached)}
          ${sparqlEscapeUri(DOWNLOAD_STATUSES.ongoing)}
        }
        FILTER (
          ?created > ${sparqlEscapeDateTime(createdAfter)} &&
          ?created < ${sparqlEscapeDateTime(createdBefore)}
        )
      }
    }
  `);
  return parseResult(result).map((r) => ({
    remoteDataObjectUri: r.remoteDataObject,
    graph: r.g,
  }));
}

async function downloadAttachment({
  remoteDataObjectUri,
  url,
  suggestedFilename,
  submissionGraph,
  downloadEvent,
}) {
  const downloadEventUri =
    downloadEvent?.downloadEventUri ??
    (await limitBackgroundWork(() =>
      startDownload({
        graph: submissionGraph,
        remoteDataObjectUri,
        defaultGraph: DEFAULT_GRAPH,
      }),
    ));

  try {
    await runDownloadWithRetry({
      remoteDataObjectUri,
      submissionGraph,
      url,
      suggestedFilename,
      downloadEventUri,
      retryCount: downloadEvent?.numberOfRetries ?? 0,
      onSuccess: (downloadResult) =>
        finishAttachmentSuccess(
          remoteDataObjectUri,
          submissionGraph,
          downloadEventUri,
          downloadResult,
        ),
      onFailure: (error) =>
        finishAttachmentFailure(
          remoteDataObjectUri,
          submissionGraph,
          downloadEventUri,
          error,
        ),
    });
  } finally {
    if (REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD) {
      const authConf = await getAuthenticationConfiguration(
        remoteDataObjectUri,
        submissionGraph,
      );
      if (authConf) await cleanCredentials(authConf);
    }
  }
}

async function finishAttachmentSuccess(
  remoteDataObjectUri,
  submissionGraph,
  downloadEventUri,
  downloadResult,
) {
  const physicalFileUri = `share://${downloadResult.physicalFileName}`;
  const { size } = await fs.stat(downloadResult.physicalPath);
  await createPhysicalFileDataObject({
    physicalUri: physicalFileUri,
    dataSourceUri: remoteDataObjectUri,
    graph: submissionGraph,
    name: downloadResult.logicalFileName,
    format: mime.lookup(downloadResult.extension) || downloadResult.contentType,
    fileSize: size,
    extension: downloadResult.extension,
    created: Date.now(),
  });
  await completeDownloadSuccess({
    graph: submissionGraph,
    defaultGraph: DEFAULT_GRAPH,
    remoteDataObjectUri,
    physicalFileUri,
    downloadEventUri,
  });
  console.log(
    `Attachment ${remoteDataObjectUri} downloaded successfully to ${physicalFileUri}`,
  );
}

async function finishAttachmentFailure(
  remoteDataObjectUri,
  submissionGraph,
  downloadEventUri,
  error,
) {
  await completeDownloadFailure({
    graph: submissionGraph,
    defaultGraph: DEFAULT_GRAPH,
    remoteDataObjectUri,
    downloadEventUri,
  });
  await reportError({
    message: `Attachment download failed permanently for remote data object ${remoteDataObjectUri}.`,
    detail: error.message,
  });
}
