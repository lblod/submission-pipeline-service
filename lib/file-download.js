import { uuid } from 'mu';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import fs from 'fs-extra';
import mime from 'mime-types';
import path from 'node:path';
import FileType from 'file-type';
import { isText } from 'istextorbinary';
import { Parser as HtmlParser } from 'htmlparser2';
import contentDisposition from 'content-disposition';
import { Agent, fetch } from 'undici';
import { FILE_STORAGE, DEFAULT_TEXT_FORMAT } from './config.js';
import { assertPublicUrl, publicLookup } from './public-address.js';

/**
 * Fetch a URL to a file in FILE_STORAGE and work out its name and extension. No
 * SPARQL here; ported from download-url-service.
 *
 * Servers with incomplete certificate chains (download-url-service bundled
 * ssl-root-cas for these) are handled with NODE_EXTRA_CA_CERTS instead.
 */

/**
 * @param {object} params
 * @param {string} params.url
 * @param {Record<string,string>} params.headers including Authorization, if any
 * @param {string} [params.suggestedFilename] e.g. ext:suggestedFilename on the remote
 *   data object (the Vandenbroele filename workaround)
 * @returns {Promise<{physicalPath: string, physicalFileName: string,
 *   logicalFileName: string, extension: string, httpStatusCode: number}>}
 * @throws {Error} with `.httpStatusCode` set if the response came back but wasn't ok
 */
export async function downloadToTempFile({ url, headers, suggestedFilename }) {
  const response = await fetchPublic(url, headers || {});

  if (!response.ok) {
    const err = new Error(`Response code http ${response.status}`);
    err.httpStatusCode = response.status;
    throw err;
  }

  const extension = '.tmp';
  const uuidName = uuid();
  const fileNameExt = tryGetFilenameWithExtension(response, suggestedFilename);
  let extensionFromFileName = path.extname(fileNameExt || '');
  let fileName;
  if (
    extensionFromFileName !== '' &&
    extensionFromFileName !== '.' &&
    mime.lookup(extensionFromFileName)
  ) {
    fileName = path.basename(fileNameExt, extensionFromFileName);
  } else {
    fileName = fileNameExt || uuidName;
    extensionFromFileName = undefined;
  }

  const physicalFileName = `${uuidName}${extension}`;
  const logicalFileName = `${fileName}${extension}`;
  const physicalPath = path.join(FILE_STORAGE, physicalFileName);

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(physicalPath),
    );
  } catch (err) {
    console.log(`${physicalPath} failed writing to disk, cleaning up...`);
    await fs.remove(physicalPath);
    throw err;
  }

  let result = {
    physicalPath,
    physicalFileName,
    logicalFileName,
    extension,
    extensionFromFileName,
    httpStatusCode: response.status,
    contentType: response.headers.get('content-type'),
  };
  result = await updateFileType(result);
  return result;
}

const publicAgent = new Agent({ connect: { lookup: publicLookup } });
const MAX_REDIRECTS = 20; // fetch's own limit

/**
 * `fetch` that only connects to public addresses, at every redirect hop. Like fetch,
 * drops the Authorization header when a redirect leaves the origin.
 *
 * @throws {Error} with `.permanent` set if the URL or a redirect is blocked
 */
async function fetchPublic(url, headers) {
  let current = url;
  let currentHeaders = headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicUrl(current);
    let response;
    try {
      response = await fetch(current, {
        headers: currentHeaders,
        redirect: 'manual',
        dispatcher: publicAgent,
      });
    } catch (e) {
      // fetch wraps the lookup's error in a generic "fetch failed"
      throw e.cause?.permanent ? e.cause : e;
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }
    await response.body?.cancel();
    const next = new URL(location, current);
    if (next.origin !== new URL(current).origin) {
      currentHeaders = Object.fromEntries(
        Object.entries(currentHeaders).filter(
          ([name]) => name.toLowerCase() !== 'authorization',
        ),
      );
    }
    current = next.href;
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects for ${url}`);
}

/**
 * Try to get the full filename from the HTTP response, with extension included. Tries
 * multiple mechanisms in order: the Content-Disposition header, URL query parameters
 * (guesswork), a suggested filename (e.g. the Vandenbroele workaround), or the last
 * path segment of the URL.
 */
function tryGetFilenameWithExtension(response, suggestedFilename) {
  const headerCD = response.headers.get('Content-Disposition');
  if (headerCD) {
    const disposition = contentDisposition.parse(headerCD);
    if (disposition?.type === 'attachment' && disposition.parameters.filename) {
      return disposition.parameters.filename;
    }
  }

  const url = new URL(response.url);
  const filenameParam =
    url.searchParams.get('filename') ||
    url.searchParams.get('file') ||
    url.searchParams.get('name');
  if (filenameParam) return filenameParam;

  if (suggestedFilename) return suggestedFilename;

  const pathSegments = (url.pathname || '').split('/');
  return pathSegments.pop();
}

/**
 * Updates the extension of a file: trusts the extension already in the filename if
 * useful, else deduces one from the Content-Type header, else guesses by content.
 */
async function updateFileType(result) {
  if (result.extensionFromFileName) {
    return renameWithExtension(result, result.extensionFromFileName);
  }

  const extension = mime.extension(result.contentType);
  if (result.contentType === 'application/octet-stream' || !extension) {
    const guessedExtension = await guessRealExtension(result.physicalPath);
    if (guessedExtension && guessedExtension !== result.extension) {
      return renameWithExtension(result, guessedExtension);
    }
    return result;
  }

  return renameWithExtension(result, `.${extension}`);
}

async function renameWithExtension(result, extension) {
  const basename = path.basename(
    result.physicalPath,
    path.extname(result.physicalPath),
  );
  const physicalFileName = basename + extension;
  const physicalPath = path.join(
    path.dirname(result.physicalPath),
    physicalFileName,
  );
  await fs.move(result.physicalPath, physicalPath);

  const logicalBasename = path.basename(
    result.logicalFileName,
    path.extname(result.logicalFileName),
  );
  return {
    ...result,
    physicalPath,
    physicalFileName,
    logicalFileName: logicalBasename + extension,
    extension,
  };
}

/** Deduce a file extension using magic numbers, falling back to text/HTML sniffing. */
async function guessRealExtension(fileAddress) {
  const fileType = await FileType.fromFile(fileAddress);
  if (fileType) return `.${fileType.ext}`;

  const buffer = await fs.readFile(fileAddress, 'utf8');
  if (isText(null, buffer)) {
    return looksLikeHtml(buffer) ? '.html' : DEFAULT_TEXT_FORMAT;
  }
  return '.bin';
}

/** Checks for a closing tag as a (imperfect, can false-positive on XML) HTML signal. */
function looksLikeHtml(buffer) {
  try {
    let hasClosingTag = false;
    const parser = new HtmlParser({ onclosetag: () => (hasClosingTag = true) });
    parser.write(buffer);
    parser.end();
    return hasClosingTag;
  } catch (err) {
    console.error('An error occurred while trying to parse html');
    console.error(err);
    return false;
  }
}
