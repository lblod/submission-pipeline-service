import { verify as argon2Verify } from 'argon2';
import { sparqlEscapeUri, sparqlEscapeString } from 'mu';
import { query } from './sparql-helpers.js';
import { PREFIXES, GRAPHS } from './constants.js';
import { USE_HASHED_KEY } from './config.js';
import { extractAuthentication } from './register-extract.js';
import { ensureAuthenticationPresent, httpError } from './validation.js';

/**
 * Verify the vendor's key against the `automatic-submission` graph.
 *
 * @param {string} vendor vendor's foaf:Agent URI
 * @param {string} key plaintext key from the request
 * @param {string} organisation bestuurseenheid URI the vendor claims to act for
 * @returns {Promise<string|undefined>} the organisation's mu:uuid if authorised,
 *   undefined otherwise (never throws for a bad key -- that's a normal outcome here)
 */
export async function verifyKeyAndOrganisation(vendor, key, organisation) {
  if (USE_HASHED_KEY) {
    const result = await query(`
      ${PREFIXES}
      SELECT DISTINCT ?organisationID ?agentHash WHERE {
        GRAPH ${sparqlEscapeUri(GRAPHS.automaticSubmission)} {
          ${sparqlEscapeUri(vendor)}
            a foaf:Agent ;
            muAccount:keyHash ?agentHash ;
            muAccount:canActOnBehalfOf ${sparqlEscapeUri(organisation)} .
        }
        ${sparqlEscapeUri(organisation)} mu:uuid ?organisationID .
      }`);
    if (result.results.bindings.length !== 1) return undefined;
    const { agentHash, organisationID } = result.results.bindings[0];
    try {
      return (await argon2Verify(agentHash.value, key))
        ? organisationID.value
        : undefined;
    } catch {
      // a malformed hash or verify error is a failed authentication, not a crash
      return undefined;
    }
  }

  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?organisationID WHERE {
      GRAPH ${sparqlEscapeUri(GRAPHS.automaticSubmission)} {
        ${sparqlEscapeUri(vendor)}
          a foaf:Agent ;
          muAccount:key ${sparqlEscapeString(key)} ;
          muAccount:canActOnBehalfOf ${sparqlEscapeUri(organisation)} .
      }
      ${sparqlEscapeUri(organisation)} mu:uuid ?organisationID .
    }`);
  if (result.results.bindings.length !== 1) return undefined;
  return result.results.bindings[0].organisationID.value;
}

/**
 * Extract and verify the request's authentication. Throws a 400 or 401 httpError.
 *
 * @param {import('n3').Store} store parsed request body
 * @returns {Promise<{organisationId: string, vendor: string}>}
 */
export async function ensureAuthorisation(store) {
  const authentication = extractAuthentication(store);
  ensureAuthenticationPresent(authentication);
  const organisationId = await verifyKeyAndOrganisation(
    authentication.vendor,
    authentication.key,
    authentication.organisation,
  );
  if (!organisationId) {
    const err = httpError(
      401,
      'Authentication failed, vendor does not have access to the organization or does not exist. If this should not be the case, please contact us at digitaalABB@vlaanderen.be for login credentials.',
    );
    err.reference = authentication.vendor;
    throw err;
  }
  return { organisationId, vendor: authentication.vendor };
}
