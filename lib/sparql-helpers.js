import { query as muQuery, update as muUpdate } from 'mu';
import { setTimeout as sleep } from 'node:timers/promises';
import { PING_DB_INTERVAL } from './config.js';

// Everything runs as sudo: requests come from vendors and background work, not from
// users with a session. Requires ALLOW_MU_AUTH_SUDO, set in the Dockerfile.
export const query = (queryString) => execute(muQuery, queryString);
export const update = (queryString) => execute(muUpdate, queryString);

// Query logging is off by default (see the Dockerfile), so failures are logged here.
async function execute(run, queryString) {
  try {
    return await run(queryString, { sudo: true });
  } catch (error) {
    console.error(
      `SPARQL query failed: ${error?.message ?? error}\n${queryString}`,
    );
    throw error;
  }
}

/** Resolves once the triplestore answers, checking every PING_DB_INTERVAL seconds. */
export async function waitForDatabase() {
  while (!(await isDatabaseUp())) {
    console.log('Waiting for the database...');
    // Unref'd: waiting alone must not keep the process alive.
    await sleep(PING_DB_INTERVAL * 1000, undefined, { ref: false });
  }
}

async function isDatabaseUp() {
  try {
    // Not through `query`: failures are expected here and needn't be logged.
    await muQuery('ASK { ?s ?p ?o }', { sudo: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert SPARQL JSON SELECT results into an array of plain objects, coercing
 * xsd:integer and xsd:dateTime bindings.
 *
 * @param {object} result SPARQL JSON result object
 * @returns {Array<object>}
 */
export function parseResult(result) {
  if (!(result.results && result.results.bindings.length)) return [];

  const bindingKeys = result.head.vars;
  return result.results.bindings.map((row) => {
    const obj = {};
    bindingKeys.forEach((key) => {
      if (
        row[key] &&
        row[key].datatype === 'http://www.w3.org/2001/XMLSchema#integer' &&
        row[key].value
      ) {
        obj[key] = parseInt(row[key].value);
      } else if (
        row[key] &&
        row[key].datatype === 'http://www.w3.org/2001/XMLSchema#dateTime' &&
        row[key].value
      ) {
        obj[key] = new Date(row[key].value);
      } else {
        obj[key] = row[key] ? row[key].value : undefined;
      }
    });
    return obj;
  });
}
