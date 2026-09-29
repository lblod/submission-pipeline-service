import http from 'node:http';
import https from 'node:https';
import { assertPublicUrl, publicLookup } from './public-address.js';

/**
 * Fetches remote JSON-LD contexts referenced by request bodies, from public hosts
 * only. Every redirect hop is checked again.
 */

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;

/**
 * @param {string} url
 * @returns {Promise<{contextUrl: null, documentUrl: string, document: object}>} a
 *   jsonld.js RemoteDocument
 */
export async function loadPublicJsonLd(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { location, document } = await get(current);
    if (!location) return { contextUrl: null, documentUrl: current, document };
    current = new URL(location, current).href;
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects for ${url}`);
}

async function get(url) {
  const parsed = assertPublicUrl(url);
  const client = parsed.protocol === 'https:' ? https : http;

  const response = await new Promise((resolve, reject) => {
    client
      .get(
        parsed,
        {
          lookup: publicLookup,
          headers: { accept: 'application/ld+json, application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
        resolve,
      )
      .on('error', reject);
  });

  const { statusCode, headers } = response;
  if (statusCode >= 300 && statusCode < 400 && headers.location) {
    response.resume();
    return { location: headers.location };
  }
  if (statusCode >= 400) {
    response.resume();
    throw new Error(`${url} responded with ${statusCode}`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      response.destroy();
      throw new Error(`${url} is larger than ${MAX_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return { document: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
