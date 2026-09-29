import { sparqlEscapeUri, sparqlEscapeDateTime } from 'mu';
import { update } from './sparql-helpers.js';
import { PREFIXES } from './constants.js';

/**
 * Job/task status transitions: replace `adms:status` and `dct:modified`, optionally
 * inserting extra triples in the same request.
 *
 * The WHERE only requires the subject to have a status; it does not check the current
 * value, so concurrent transitions of one resource are last-writer-wins.
 */

/**
 * Build the SPARQL Update for one transition, so callers can bundle several into one
 * request (see `runStatusTransitions`).
 *
 * @param {object} params
 * @param {string} params.graph
 * @param {string} params.subject task or job URI
 * @param {string} params.newStatus
 * @param {string} [params.extraInsert] triples to insert in the same GRAPH block,
 *   e.g. a results container or the next task
 * @returns {string}
 */
export function buildStatusTransitionQuery({
  graph,
  subject,
  newStatus,
  extraInsert = '',
}) {
  const graphSparql = sparqlEscapeUri(graph);
  const subjectSparql = sparqlEscapeUri(subject);
  const nowSparql = sparqlEscapeDateTime(new Date());
  return `
    DELETE {
      GRAPH ${graphSparql} {
        ${subjectSparql}
          adms:status ?oldStatus ;
          dct:modified ?oldModified .
      }
    }
    INSERT {
      GRAPH ${graphSparql} {
        ${subjectSparql}
          adms:status ${sparqlEscapeUri(newStatus)} ;
          dct:modified ${nowSparql} .
        ${extraInsert}
      }
    }
    WHERE {
      GRAPH ${graphSparql} {
        ${subjectSparql}
          adms:status ?oldStatus ;
          dct:modified ?oldModified .
      }
    }
  `;
}

/**
 * Run one status transition.
 * @param {Parameters<typeof buildStatusTransitionQuery>[0]} params
 */
export async function transitionTaskStatus(params) {
  await update(`${PREFIXES}\n${buildStatusTransitionQuery(params)}`);
}

/**
 * Run several transitions (e.g. a task and its job failing) in one request.
 *
 * @param {Array<Parameters<typeof buildStatusTransitionQuery>[0]>} transitions
 */
export async function runStatusTransitions(transitions) {
  const combined = transitions.map(buildStatusTransitionQuery).join('\n;\n');
  await update(`${PREFIXES}\n${combined}`);
}
