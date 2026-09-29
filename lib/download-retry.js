import { setTimeout as sleep } from 'node:timers/promises';
import { stat } from 'node:fs/promises';
import mime from 'mime-types';
import { ClientCredentials } from 'simple-oauth2';
import { SECURITY_SCHEMES } from './constants.js';
import { CACHING_MAX_RETRIES } from './config.js';
import {
  getDownloadContext,
  getBasicCredentials,
  getOauthCredentials,
  retryDownloadEvent,
  markDownloadEventAttemptFailed,
  saveHttpStatusCode,
  saveCacheError,
  createPhysicalFileDataObject,
} from './download-queries.js';
import { downloadToTempFile } from './file-download.js';
import { limitBackgroundWork } from './concurrency-limiter.js';

/**
 * Download with retry and exponential backoff, shared by the publication download
 * and attachment downloads. Calls `onSuccess` with the physical file's URI once the
 * file is on disk and has its own resource, or `onFailure` once retries are
 * exhausted. Only the attempts take a concurrency slot,
 * not the waits in between.
 */

/**
 * The headers stored on the remote data object, plus Authorization if it has
 * credentials.
 *
 * @param {string} remoteDataObjectUri
 * @param {string} graph
 * @returns {Promise<Record<string, string>>}
 */
async function resolveDownloadHeaders(remoteDataObjectUri, graph) {
  const { headers, credentialsType } = await getDownloadContext(
    remoteDataObjectUri,
    graph,
  );
  const headerMap = Object.fromEntries(headers.map((h) => [h.name, h.value]));

  if (credentialsType === SECURITY_SCHEMES.basicAuth) {
    const creds = await getBasicCredentials(remoteDataObjectUri, graph);
    const encoded = Buffer.from(`${creds.user}:${creds.pass}`).toString(
      'base64',
    );
    headerMap.Authorization = `Basic ${encoded}`;
  } else if (credentialsType === SECURITY_SCHEMES.oauth2) {
    const creds = await getOauthCredentials(remoteDataObjectUri, graph);
    const tokenUrl = new URL(creds.accessTokenUri);
    const client = new ClientCredentials({
      client: { id: creds.clientId, secret: creds.clientSecret },
      auth: {
        tokenHost: `${tokenUrl.protocol}//${tokenUrl.host}`,
        tokenPath: tokenUrl.pathname,
      },
    });
    const tokenResponse = await client.getToken({ scope: creds.scope });
    headerMap.Authorization = `Bearer ${tokenResponse.token.access_token}`;
  }

  return headerMap;
}

/**
 * Backoff before retry `retryCount + 1`, in ms, as in download-url-service. With the
 * default CACHING_MAX_RETRIES=30 the last wait is ~27 hours and all waits add up to
 * ~4.4 days.
 */
export function calcTimeout(retryCount) {
  return Math.round(Math.exp(0.3 * retryCount + 10));
}

/**
 * @param {object} params
 * @param {string} params.remoteDataObjectUri
 * @param {string} params.submissionGraph
 * @param {string} params.url
 * @param {string} [params.suggestedFilename]
 * @param {string} params.downloadEventUri
 * @param {number} [params.retryCount]
 * @param {(downloadResult: object) => Promise<any>} params.onSuccess
 * @param {(error: Error) => Promise<any>} params.onFailure
 */
export async function runDownloadWithRetry(params) {
  const { remoteDataObjectUri, downloadEventUri, onSuccess, onFailure } =
    params;
  const attempt = () => limitBackgroundWork(() => attemptDownload(params));

  let retryCount = params.retryCount ?? 0;
  let result = await attempt();
  while (
    result.error &&
    !result.error.permanent &&
    retryCount + 1 < CACHING_MAX_RETRIES
  ) {
    const waitMs = calcTimeout(retryCount);
    console.log(
      `Retry ${retryCount + 1}/${CACHING_MAX_RETRIES} for ${remoteDataObjectUri} in ~${Math.round(waitMs / 1000)}s`,
    );
    await sleep(waitMs);
    retryCount++;
    await retryDownloadEvent(downloadEventUri, retryCount);
    result = await attempt();
  }

  // After the attempts: a failure while recording success must not re-download.
  if (result.error) return onFailure(result.error);
  const physicalFileUri = await createPhysicalFile(
    result.downloadResult,
    remoteDataObjectUri,
    params.submissionGraph,
  );
  return onSuccess(physicalFileUri);
}

/** Creates the downloaded file's own resource and returns its URI. */
async function createPhysicalFile(downloadResult, remoteDataObjectUri, graph) {
  const physicalUri = `share://${downloadResult.physicalFileName}`;
  const { size } = await stat(downloadResult.physicalPath);
  await createPhysicalFileDataObject({
    physicalUri,
    dataSourceUri: remoteDataObjectUri,
    graph,
    name: downloadResult.logicalFileName,
    format: mime.lookup(downloadResult.extension) || downloadResult.contentType,
    fileSize: size,
    extension: downloadResult.extension,
    created: Date.now(),
  });
  return physicalUri;
}

/**
 * One download attempt. A failed attempt is recorded on the remote data object and
 * download event, and returned rather than thrown.
 *
 * @returns {Promise<{downloadResult?: object, error?: Error}>}
 */
async function attemptDownload({
  remoteDataObjectUri,
  submissionGraph,
  url,
  suggestedFilename,
  downloadEventUri,
}) {
  try {
    const headers = await resolveDownloadHeaders(
      remoteDataObjectUri,
      submissionGraph,
    );
    const downloadResult = await downloadToTempFile({
      url,
      headers,
      suggestedFilename,
    });
    await saveHttpStatusCode(
      remoteDataObjectUri,
      submissionGraph,
      downloadResult.httpStatusCode,
    );
    return { downloadResult };
  } catch (error) {
    if (error.httpStatusCode) {
      await saveHttpStatusCode(
        remoteDataObjectUri,
        submissionGraph,
        error.httpStatusCode,
      );
    }
    await saveCacheError(remoteDataObjectUri, submissionGraph, error);
    console.error(
      `Error downloading ${remoteDataObjectUri} (${url}): ${error.message}`,
    );
    await markDownloadEventAttemptFailed(downloadEventUri);
    return { error };
  }
}
