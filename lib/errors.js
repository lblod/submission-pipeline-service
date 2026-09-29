import {
  uuid,
  sparqlEscapeString,
  sparqlEscapeDateTime,
  sparqlEscapeUri,
} from 'mu';
import { update } from './sparql-helpers.js';
import { GRAPHS, CREATORS } from './constants.js';

/**
 * Write an oslc:Error to the shared error graph, in the shape the error dashboard
 * already reads.
 *
 * @param {object} params
 * @param {string} params.message human-readable summary
 * @param {string} [params.detail] longer detail, e.g. a stack trace or JSON blob
 * @param {string} [params.reference] URI this error relates to (e.g. a vendor)
 * @param {string} [params.creator] defaults to the automatic-submission creator URI
 * @returns {Promise<string|undefined>} the new error's URI, or undefined if the write
 *   itself failed (logged, not thrown — an error report should never crash the caller)
 */
export async function reportError({
  message,
  detail,
  reference,
  creator = CREATORS.automaticSubmission,
}) {
  if (!message)
    throw new Error('Error needs a message describing what went wrong.');
  const id = uuid();
  const uri = `http://data.lblod.info/errors/${id}`;
  const referenceTriple = reference
    ? `${sparqlEscapeUri(uri)} dct:references ${sparqlEscapeUri(reference)} .`
    : '';
  const detailTriple = detail
    ? `${sparqlEscapeUri(uri)} oslc:largePreview ${sparqlEscapeString(detail)} .`
    : '';
  const q = `
    PREFIX mu:   <http://mu.semte.ch/vocabularies/core/>
    PREFIX oslc: <http://open-services.net/ns/core#>
    PREFIX dct:  <http://purl.org/dc/terms/>

    INSERT DATA {
      GRAPH ${sparqlEscapeUri(GRAPHS.error)} {
        ${sparqlEscapeUri(uri)}
          a oslc:Error ;
          mu:uuid ${sparqlEscapeString(id)} ;
          dct:subject ${sparqlEscapeString('Automatic Submission Service')} ;
          oslc:message ${sparqlEscapeString(message)} ;
          dct:created ${sparqlEscapeDateTime(new Date().toISOString())} ;
          dct:creator ${sparqlEscapeUri(creator)} .
        ${referenceTriple}
        ${detailTriple}
      }
    }`;
  try {
    await update(q);
    return uri;
  } catch (e) {
    console.warn(
      `[WARN] Something went wrong while trying to store an error.\nMessage: ${e}\nQuery: ${q}`,
    );
  }
}
