import {
  uuid,
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeDateTime,
} from 'mu';
import { query, update } from './sparql-helpers.js';
import {
  PREFIXES,
  JOB_PREFIX,
  DOWNLOAD_STATUSES,
  TASK_STATUSES,
  CREATORS,
} from './constants.js';
import {
  transitionTaskStatus,
  runStatusTransitions,
} from './task-transitions.js';
import {
  storeToTurtle,
  extractMeldingUri,
  findSubmittedResource,
  extractLocationUrl,
  extractInfoForRegister,
} from './register-extract.js';
import {
  cloneAuthenticationConfiguration,
  cleanCredentials,
} from './credentials.js';
import { reportError } from './errors.js';

/**
 * Whether `resource` has any triples at all. Backs the /melding 409 check.
 *
 * @param {string} resource
 * @returns {Promise<boolean>}
 */
export async function isSubmitted(resource) {
  const result = await query(`
    SELECT (COUNT(*) as ?count) WHERE {
      ${sparqlEscapeUri(resource)} ?p ?o .
    }
  `);
  return parseInt(result.results.bindings[0].count.value) > 0;
}

/**
 * The register step: creates the job, register task, submission, remote data object
 * and download task. See README.md "Step 1 — register" for the resulting triples.
 *
 * @param {object} params
 * @param {import('n3').Store} params.store parsed request body
 * @param {string} params.submissionGraph
 * @returns {Promise<{submissionUri: string, jobUri: string, downloadTaskUri: string,
 *   remoteDataObjectUri: string, url: string}>}
 */
export async function registerSubmission({ store, submissionGraph }) {
  const meldingUri = extractMeldingUri(store);
  const submittedResource = findSubmittedResource(store);
  const locationUrl = extractLocationUrl(store);
  // Its secrets are part of `turtle` below, so they must be cleaned up on failure.
  const { authenticationConfiguration } = extractInfoForRegister(store);

  const jobId = uuid();
  const jobUri = JOB_PREFIX.concat(jobId);
  const registerTaskId = uuid();
  const registerTaskUri = JOB_PREFIX.concat(registerTaskId);
  const remoteDataId = uuid();
  const remoteDataUri = `http://data.lblod.info/id/remote-data-objects/${remoteDataId}`;
  const downloadTaskId = uuid();
  const downloadTaskUri = JOB_PREFIX.concat(downloadTaskId);
  const nowSparql = sparqlEscapeDateTime(new Date());

  const turtle = await storeToTurtle(store);

  // If this first write fails there is no job yet to mark failed, so it stays
  // outside the try/catch below.
  await update(`
    ${PREFIXES}
    INSERT DATA {
      GRAPH ${sparqlEscapeUri(submissionGraph)} {
        asj:${jobId}
          a cogs:Job ;
          mu:uuid ${sparqlEscapeString(jobId)} ;
          dct:creator services:automatic-submission-service ;
          adms:status js:busy ;
          dct:created ${nowSparql} ;
          dct:modified ${nowSparql} ;
          task:cogsOperation cogs:TransformationProcess ;
          task:operation jobo:automaticSubmissionFlow ;
          prov:generated ${sparqlEscapeUri(meldingUri)} .

        asj:${registerTaskId}
          a task:Task ;
          mu:uuid ${sparqlEscapeString(registerTaskId)} ;
          adms:status js:busy ;
          dct:created ${nowSparql} ;
          dct:modified ${nowSparql} ;
          task:cogsOperation cogs:TransformationProcess ;
          task:operation tasko:register ;
          dct:creator services:automatic-submission-service ;
          task:index "0" ;
          dct:isPartOf asj:${jobId} .

        ${turtle}
        ${sparqlEscapeUri(submittedResource)} a foaf:Document, ext:SubmissionDocument .

        ${sparqlEscapeUri(remoteDataUri)}
          a nfo:RemoteDataObject, nfo:FileDataObject ;
          rpioHttp:requestHeader <http://data.lblod.info/request-headers/accept/text/html> ;
          mu:uuid ${sparqlEscapeString(remoteDataId)} ;
          nie:url ${sparqlEscapeUri(locationUrl)} ;
          dct:creator ${sparqlEscapeUri(CREATORS.automaticSubmission)} ;
          adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.readyToBeCached)} ;
          dct:created ${nowSparql} ;
          dct:modified ${nowSparql} .

        <http://data.lblod.info/request-headers/accept/text/html>
          a http:RequestHeader ;
          http:fieldValue "text/html" ;
          http:fieldName "Accept" ;
          http:hdrName <http://www.w3.org/2011/http-headers#accept> .

        ${sparqlEscapeUri(meldingUri)}
          nie:hasPart ${sparqlEscapeUri(remoteDataUri)} ;
          dct:created ${nowSparql} ;
          dct:modified ${nowSparql} .
      }
    }
  `);

  let clonedAuthConf;
  try {
    // Separate request on purpose: combining it with the insert above silently lost
    // the uuid in the past (automatic-submission-service e6987b1).
    await update(`
      ${PREFIXES}
      INSERT {
        GRAPH ${sparqlEscapeUri(submissionGraph)} {
          ${sparqlEscapeUri(submittedResource)} mu:uuid ${sparqlEscapeString(uuid())} .
        }
      } WHERE {
        GRAPH ${sparqlEscapeUri(submissionGraph)} {
          ${sparqlEscapeUri(submittedResource)} a foaf:Document .
          FILTER NOT EXISTS { ${sparqlEscapeUri(submittedResource)} mu:uuid ?uuid . }
        }
      }
    `);

    // Cloned so the download can delete its copy while attachments still need theirs.
    clonedAuthConf = await cloneAuthenticationConfiguration({
      targetUri: remoteDataUri,
      sourceUri: meldingUri,
      graph: submissionGraph,
    });

    // Register task -> success, creating its results container and the download task.
    const resultContainerId = uuid();
    const harvestingCollectionId = uuid();
    const inputContainerId = uuid();
    await transitionTaskStatus({
      graph: submissionGraph,
      subject: registerTaskUri,
      newStatus: TASK_STATUSES.success,
      extraInsert: `
        ${sparqlEscapeUri(registerTaskUri)}
          task:resultsContainer asj:${resultContainerId} .
        asj:${resultContainerId}
          a nfo:DataContainer ;
          mu:uuid ${sparqlEscapeString(resultContainerId)} ;
          task:hasHarvestingCollection asj:${harvestingCollectionId} .
        asj:${harvestingCollectionId}
          a hrvst:HarvestingCollection ;
          dct:creator services:automatic-submission-service ;
          dct:hasPart ${sparqlEscapeUri(remoteDataUri)} .

        asj:${downloadTaskId}
          a task:Task ;
          mu:uuid ${sparqlEscapeString(downloadTaskId)} ;
          adms:status js:scheduled ;
          dct:created ${nowSparql} ;
          dct:modified ${nowSparql} ;
          task:cogsOperation cogs:WebServiceLookup ;
          task:operation tasko:download ;
          dct:creator services:automatic-submission-service ;
          task:index "1" ;
          dct:isPartOf ${sparqlEscapeUri(jobUri)} ;
          task:inputContainer asj:${inputContainerId} .
        asj:${inputContainerId}
          a nfo:DataContainer ;
          mu:uuid ${sparqlEscapeString(inputContainerId)} ;
          task:hasHarvestingCollection asj:${harvestingCollectionId} .
      `,
    });

    return {
      submissionUri: meldingUri,
      jobUri,
      downloadTaskUri,
      remoteDataObjectUri: remoteDataUri,
      url: locationUrl,
    };
  } catch (e) {
    const errorUri = await reportError({
      message: `Something went wrong during the storage of submission ${meldingUri}. This is monitored via task ${registerTaskUri}.`,
      detail: e.message,
    });
    await runStatusTransitions([
      {
        graph: submissionGraph,
        subject: registerTaskUri,
        newStatus: TASK_STATUSES.failed,
        extraInsert: `${sparqlEscapeUri(registerTaskUri)} task:error ${sparqlEscapeUri(errorUri)} .`,
      },
      {
        graph: submissionGraph,
        subject: jobUri,
        newStatus: TASK_STATUSES.failed,
        extraInsert: `${sparqlEscapeUri(jobUri)} task:error ${sparqlEscapeUri(errorUri)} .`,
      },
    ]);
    e.alreadyStoredError = true;
    if (authenticationConfiguration)
      await cleanCredentials(authenticationConfiguration);
    if (clonedAuthConf?.newAuthConf)
      await cleanCredentials(clonedAuthConf.newAuthConf);
    throw e;
  }
}
