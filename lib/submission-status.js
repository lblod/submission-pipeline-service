import { sparqlEscapeUri } from 'mu';
import { SparqlJsonParser } from 'sparqljson-parse';
import { DataFactory } from 'n3';
import { query } from './sparql-helpers.js';
import { PREFIXES } from './constants.js';

const { quad } = DataFactory;

/**
 * Backs `POST /status`. The JSON-LD context and frame are part of the vendor API.
 *
 * The CONSTRUCT result is parsed as SELECT JSON: Virtuoso returns CONSTRUCT results
 * as ?s/?p/?o bindings when asked for application/sparql-results+json.
 */

export const JobStatusContext = {
  cogs: 'http://vocab.deri.ie/cogs#',
  adms: 'http://www.w3.org/ns/adms#',
  prov: 'http://www.w3.org/ns/prov#',
  meb: 'http://rdf.myexperiment.org/ontologies/base/',
  oslc: 'http://open-services.net/ns/core#',
  task: 'http://redpencil.data.gift/vocabularies/tasks/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  status: { '@id': 'adms:status', '@type': '@id' },
  generated: { '@id': 'prov:generated', '@type': '@id' },
  error: { '@id': 'task:error', '@type': '@id' },
  message: { '@id': 'oslc:message' },
};

export const JobStatusFrame = {
  '@context': {
    cogs: 'http://vocab.deri.ie/cogs#',
    adms: 'http://www.w3.org/ns/adms#',
    prov: 'http://www.w3.org/ns/prov#',
    meb: 'http://rdf.myexperiment.org/ontologies/base/',
    oslc: 'http://open-services.net/ns/core#',
    task: 'http://redpencil.data.gift/vocabularies/tasks/',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    status: { '@id': 'adms:status', '@type': '@id' },
    error: { '@id': 'task:error', '@type': 'oslc:Error' },
    generated: { '@id': 'prov:generated', '@type': 'meb:Submission' },
    message: { '@id': 'oslc:message', '@type': 'xsd:string' },
  },
  '@type': 'cogs:Job',
  generated: { '@embed': '@always' },
  error: { '@embed': '@always' },
};

/**
 * @param {string} submissionUri
 * @returns {Promise<{statusRdfJSTriples: import('n3').Quad[], JobStatusContext: object, JobStatusFrame: object}>}
 */
export async function getSubmissionStatusRdfJS(submissionUri) {
  const response = await query(`
    ${PREFIXES}
    CONSTRUCT {
      ?job
        a cogs:Job ;
        adms:status ?jobStatus ;
        prov:generated ?submission ;
        task:error ?error .
      ${sparqlEscapeUri(submissionUri)}
        rdf:type meb:Submission ;
        adms:status ?submissionStatus .
      ?error
        a oslc:Error ;
        oslc:message ?message .
    }
    WHERE {
      ${sparqlEscapeUri(submissionUri)}
        rdf:type meb:Submission ;
        adms:status ?submissionStatus .
      ?job
        a cogs:Job ;
        dct:creator services:automatic-submission-service ;
        adms:status ?jobStatus ;
        task:cogsOperation cogs:TransformationProcess ;
        task:operation jobo:automaticSubmissionFlow ;
        prov:generated ?submission .
      OPTIONAL {
        ?job task:error ?error .
        ?error a oslc:Error ; oslc:message ?message .
      }
    }
  `);
  const parsedResults = new SparqlJsonParser().parseJsonResults(response);
  const statusRdfJSTriples = parsedResults.map((binding) =>
    quad(binding.s, binding.p, binding.o),
  );
  return { statusRdfJSTriples, JobStatusContext, JobStatusFrame };
}
