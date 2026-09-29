import {
  uuid,
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeInt,
  sparqlEscapeDateTime,
} from 'mu';
import fs from 'fs-extra';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { query, update, parseResult } from './sparql-helpers.js';
import { PREFIXES, TASK_STATUSES, JOB_PREFIX, CREATORS } from './constants.js';
import { FILE_STORAGE } from './config.js';
import {
  transitionTaskStatus,
  runStatusTransitions,
} from './task-transitions.js';
import RdfaExtractor from './rdfa-extractor.js';
import {
  enrichSubmission,
  enrichWithAttachmentInfo,
  calculateAttachmentsToDownload,
} from './submission-enricher.js';
import {
  scheduleAttachment,
  dispatchAttachmentDownload,
  findExistingAttachments,
  resumeAttachmentDownload,
} from './attachments.js';
import { limitBackgroundWork } from './concurrency-limiter.js';
import { reportError } from './errors.js';

/**
 * The import step: harvest RDFa from the downloaded publication, enrich it and write
 * it to a Turtle file. See README.md "Step 3 — import".
 *
 * Attachments are scheduled here because the Turtle links to them, but their
 * downloads are not awaited: an attachment failing never fails the import. A re-run
 * reuses the attachments of the interrupted run, resuming their downloads.
 *
 * @param {object} params
 * @param {string} params.jobUri
 * @param {string} params.importTaskUri
 * @param {string} params.remoteDataObjectUri the downloaded publication
 * @param {string} params.submissionGraph
 * @returns {Promise<{logicalUri: string, physicalUri: string}>}
 */
export function performImport(params) {
  return limitBackgroundWork(() => runImport(params));
}

async function runImport({
  jobUri,
  importTaskUri,
  remoteDataObjectUri,
  submissionGraph,
}) {
  await transitionTaskStatus({
    graph: submissionGraph,
    subject: importTaskUri,
    newStatus: TASK_STATUSES.busy,
  });

  try {
    const { submission, documentUrl, submittedDocument, fileUri } =
      await getSubmissionInfo(remoteDataObjectUri, submissionGraph);

    const html = await loadFileData(fileUri);
    const extractor = new RdfaExtractor(html, documentUrl);
    const triples = extractor.rdfa();

    const enrichments = await enrichSubmission(
      submittedDocument,
      fileUri,
      remoteDataObjectUri,
      triples,
      documentUrl,
    );
    extractor.add(enrichments);

    const attachmentUrls = calculateAttachmentsToDownload(
      submittedDocument,
      triples,
    );
    if (attachmentUrls.length) {
      console.log(
        `Found ${attachmentUrls.length} attachment(s) for ${submission}`,
      );
      const existingAttachments = await findExistingAttachments(
        submission,
        submissionGraph,
      );
      for (const attachmentUrl of attachmentUrls) {
        let remoteDataObjectUri = existingAttachments
          .get(attachmentUrl)
          ?.shift();
        if (remoteDataObjectUri) {
          await resumeAttachmentDownload(remoteDataObjectUri, submissionGraph);
        } else {
          const attachment = await scheduleAttachment({
            submission,
            attachmentUrl,
            submissionGraph,
            html,
          });
          remoteDataObjectUri = attachment.remoteDataObjectUri;
          dispatchAttachmentDownload({ ...attachment, submissionGraph });
        }
        extractor.add(
          enrichWithAttachmentInfo(
            submittedDocument,
            remoteDataObjectUri,
            attachmentUrl,
          ),
        );
      }
    }

    const ttl = extractor.ttl();
    const { logicalUri, physicalUri } = await writeTtlFile(
      ttl,
      submittedDocument,
      remoteDataObjectUri,
      submissionGraph,
    );
    console.log(
      `Extracted data for submission <${submission}> from <${remoteDataObjectUri}> to <${logicalUri}>`,
    );

    await finishSuccess({ submissionGraph, importTaskUri, logicalUri });
    return { logicalUri, physicalUri };
  } catch (error) {
    await finishFailure({ jobUri, submissionGraph, importTaskUri, error });
    const err = new Error(
      `Import of ${remoteDataObjectUri} failed: ${error.message}`,
    );
    err.alreadyStoredError = true;
    throw err;
  }
}

/**
 * The submission, submitted document, publication URL and downloaded file for a
 * publication's remote data object.
 */
async function getSubmissionInfo(remoteDataObjectUri, graph) {
  const result = await query(`
    ${PREFIXES}
    SELECT ?submission ?documentUrl ?fileUri ?submittedDocument WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ?fileUri nie:dataSource ${sparqlEscapeUri(remoteDataObjectUri)} .
        ?submission
          nie:hasPart ${sparqlEscapeUri(remoteDataObjectUri)} ;
          prov:atLocation ?documentUrl ;
          dct:subject ?submittedDocument .
      }
    }
  `);
  const row = parseResult(result)[0];
  if (!row) {
    throw new Error(
      `Could not find the information about the submission for file ${remoteDataObjectUri}`,
    );
  }
  return row;
}

/**
 * Remove the Turtle file and its triples left by an interrupted import, so
 * lib/reconciliation.js can re-run it without a second `dct:source`. No-op if no
 * Turtle file was written.
 *
 * @param {string} remoteDataObjectUri the downloaded publication
 * @param {string} submissionGraph
 */
export async function rollbackPartialImport(
  remoteDataObjectUri,
  submissionGraph,
) {
  const { submittedDocument } = await getSubmissionInfo(
    remoteDataObjectUri,
    submissionGraph,
  );

  const result = await query(`
    ${PREFIXES}
    SELECT ?physicalTtlFile WHERE {
      GRAPH ${sparqlEscapeUri(submissionGraph)} {
        ${sparqlEscapeUri(submittedDocument)} dct:source ?physicalTtlFile .
        ?physicalTtlFile dct:type <http://data.lblod.gift/concepts/harvested-data> .
      }
    }
  `);
  const physicalTtlFile = parseResult(result)[0]?.physicalTtlFile;
  if (!physicalTtlFile) return;

  const filePath = shareUriToPath(physicalTtlFile);
  // Not recursive: this only ever removes the one Turtle file.
  await rm(filePath, { force: true }).catch((e) => {
    console.log(
      `Could not remove ${filePath} during import rollback (continuing): ${e.message}`,
    );
  });

  await update(`
    ${PREFIXES}
    DELETE {
      GRAPH ${sparqlEscapeUri(submissionGraph)} {
        ${sparqlEscapeUri(submittedDocument)} dct:source ${sparqlEscapeUri(physicalTtlFile)} .
        ${sparqlEscapeUri(physicalTtlFile)} ?pp ?po .
        ?logicalTtlFile ?lp ?lo .
      }
    }
    WHERE {
      GRAPH ${sparqlEscapeUri(submissionGraph)} {
        ${sparqlEscapeUri(physicalTtlFile)} ?pp ?po .
        OPTIONAL {
          ${sparqlEscapeUri(physicalTtlFile)} nie:dataSource ?logicalTtlFile .
          ?logicalTtlFile dct:format "text/turtle" .
          ?logicalTtlFile ?lp ?lo .
        }
      }
    }
  `);
  console.log(
    `Rolled back partial import: removed ${physicalTtlFile} and its logical file`,
  );
}

/**
 * The path of a share:// URI inside FILE_STORAGE. Throws for anything that would
 * resolve outside it: these URIs are read from a graph the vendor can write to.
 *
 * @param {string} fileUri
 * @returns {string}
 */
function shareUriToPath(fileUri) {
  if (!fileUri.startsWith('share://')) {
    throw new Error(`Not a share:// URI: ${fileUri}`);
  }
  const root = path.resolve(FILE_STORAGE);
  const filePath = path.resolve(root, fileUri.slice('share://'.length));
  const relative = path.relative(root, filePath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`File URI ${fileUri} points outside ${FILE_STORAGE}`);
  }
  return filePath;
}

/** @param {string} fileUri a share:// URI */
async function loadFileData(fileUri) {
  const filePath = shareUriToPath(fileUri);
  console.log(`Getting contents of file ${fileUri}`);
  return fs.readFile(filePath, 'utf-8');
}

/**
 * Write the Turtle to FILE_STORAGE/submissions and link the file to the submitted
 * document and the publication it was harvested from.
 *
 * @param {string} content Turtle to write
 * @param {string} submittedDocument
 * @param {string} remoteFile the downloaded publication's remote data object
 * @param {string} submissionGraph
 * @returns {Promise<{physicalUri: string, logicalUri: string}>}
 */
async function writeTtlFile(
  content,
  submittedDocument,
  remoteFile,
  submissionGraph,
) {
  const physicalId = uuid();
  const logicalId = uuid();
  const filename = `${physicalId}.ttl`;
  const filePath = path.join(FILE_STORAGE, 'submissions', filename);
  const physicalUri = `share://submissions/${filename}`;
  const logicalUri = JOB_PREFIX.concat(logicalId);
  const nowSparql = sparqlEscapeDateTime(new Date());

  try {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, 'utf-8');
  } catch (e) {
    console.log(`Failed to write TTL to file <${filePath}>.`);
    throw e;
  }

  try {
    const { size } = await fs.stat(filePath);

    await update(`
      ${PREFIXES}
      INSERT {
        GRAPH ${sparqlEscapeUri(submissionGraph)} {
          ${sparqlEscapeUri(physicalUri)}
            a nfo:FileDataObject ;
            nie:dataSource asj:${logicalId} ;
            nie:dataSource ?localFile ;
            mu:uuid ${sparqlEscapeString(physicalId)} ;
            dct:type <http://data.lblod.gift/concepts/harvested-data> ;
            nfo:fileName ${sparqlEscapeString(filename)} ;
            dct:creator ${sparqlEscapeUri(CREATORS.importSubmission)} ;
            dct:created ${nowSparql} ;
            dct:modified ${nowSparql} ;
            dct:format "text/turtle" ;
            nfo:fileSize ${sparqlEscapeInt(size)} ;
            dbpedia:fileExtension "ttl" .

          asj:${logicalId}
            a nfo:FileDataObject ;
            mu:uuid ${sparqlEscapeString(logicalId)} ;
            dct:type <http://data.lblod.gift/concepts/harvested-data> ;
            nfo:fileName ${sparqlEscapeString(filename)} ;
            dct:creator ${sparqlEscapeUri(CREATORS.importSubmission)} ;
            dct:created ${nowSparql} ;
            dct:modified ${nowSparql} ;
            dct:format "text/turtle" ;
            nfo:fileSize ${sparqlEscapeInt(size)} ;
            dbpedia:fileExtension "ttl" .

          ${sparqlEscapeUri(submittedDocument)} dct:source ${sparqlEscapeUri(physicalUri)} .
        }
      }
      WHERE {
        GRAPH ${sparqlEscapeUri(submissionGraph)} {
          ${sparqlEscapeUri(remoteFile)} a nfo:FileDataObject .
          ?localFile nie:dataSource ${sparqlEscapeUri(remoteFile)} .
        }
      }`);
  } catch (e) {
    console.log(
      `Failed to write TTL resource <${physicalUri}> to triplestore.`,
    );
    throw e;
  }

  return { physicalUri, logicalUri };
}

async function finishSuccess({ submissionGraph, importTaskUri, logicalUri }) {
  const resultContainerId = uuid();
  await transitionTaskStatus({
    graph: submissionGraph,
    subject: importTaskUri,
    newStatus: TASK_STATUSES.success,
    extraInsert: `
      ${sparqlEscapeUri(importTaskUri)} task:resultsContainer asj:${resultContainerId} .
      asj:${resultContainerId}
        a nfo:DataContainer ;
        mu:uuid ${sparqlEscapeString(resultContainerId)} ;
        task:hasFile ${sparqlEscapeUri(logicalUri)} .
    `,
  });
}

async function finishFailure({
  jobUri,
  submissionGraph,
  importTaskUri,
  error,
}) {
  const errorUri = await reportError({
    message: `Something went wrong while importing for task ${importTaskUri}.`,
    detail: error.message,
  });
  await runStatusTransitions([
    {
      graph: submissionGraph,
      subject: importTaskUri,
      newStatus: TASK_STATUSES.failed,
      extraInsert: `${sparqlEscapeUri(importTaskUri)} task:error ${sparqlEscapeUri(errorUri)} .`,
    },
    {
      graph: submissionGraph,
      subject: jobUri,
      newStatus: TASK_STATUSES.failed,
      extraInsert: `${sparqlEscapeUri(jobUri)} task:error ${sparqlEscapeUri(errorUri)} .`,
    },
  ]);
}
