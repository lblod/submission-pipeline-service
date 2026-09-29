import { uuid } from 'mu';
import { query } from './sparql-helpers.js';
import Triple from './triple.js';

/**
 * Enrichment of harvested RDFa and attachment discovery for the import step. See
 * README.md "Step 3 — import" for what each enrichment adds.
 */

const RESOURCE_DATATYPE = 'http://www.w3.org/2000/01/rdf-schema#Resource';

const CENTRAAL_BESTUUR_VAN_EREDIENST_DOCUMENT_TYPES = [
  'https://data.vlaanderen.be/id/concept/BesluitDocumentType/18833df2-8c9e-4edd-87fd-b5c252337349',
  'https://data.vlaanderen.be/id/concept/BesluitDocumentType/672bf096-dccd-40af-ab60-bd7de15cc461',
  'https://data.vlaanderen.be/id/concept/BesluitDocumentType/2c9ada23-1229-4c7e-a53e-acddc9014e4e',
];

/**
 * @param {string} submittedDocument
 * @param {Array<{subject: string, predicate: string, object: string}>} triples
 * @returns {boolean}
 */
export function isCentraalBestuurVanEredienstDocument(
  submittedDocument,
  triples,
) {
  const documentTypes = triples
    .filter(
      (t) =>
        t.subject == submittedDocument &&
        (t.predicate == 'a' ||
          t.predicate == 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
    )
    .map((t) => t.object);
  return documentTypes.some((type) =>
    CENTRAAL_BESTUUR_VAN_EREDIENST_DOCUMENT_TYPES.includes(type),
  );
}

/**
 * Find every attachment URL to download for a submission, from its harvested triples.
 * Three independent sources, all additive:
 *  - for a Centraal Bestuur van Eredienst document, dct:source of anything it
 *    dct:relation-links to;
 *  - dct:source directly on the submitted document (the simplest case: a decision
 *    with just a URI, referring to a PDF for everything else -- mainly VGC);
 *  - eli:related_to on the submitted document.
 *
 * @param {string} submittedDocument
 * @param {Array<{subject: string, predicate: string, object: string}>} triples
 * @returns {string[]} attachment URLs, not deduplicated (matching the old behaviour)
 */
export function calculateAttachmentsToDownload(submittedDocument, triples) {
  let allAttachments = [];

  if (isCentraalBestuurVanEredienstDocument(submittedDocument, triples)) {
    const relatedDocuments = triples
      .filter(
        (t) =>
          t.subject == submittedDocument &&
          t.predicate == 'http://purl.org/dc/terms/relation',
      )
      .map((t) => t.object);
    for (const docUri of relatedDocuments) {
      const attachments = triples
        .filter(
          (t) =>
            t.subject == docUri &&
            t.predicate == 'http://purl.org/dc/terms/source',
        )
        .map((t) => t.object);
      allAttachments = [...allAttachments, ...attachments];
    }
  }

  const attachmentsAsSourceOfDecisions = triples
    .filter(
      (t) =>
        t.subject == submittedDocument &&
        t.predicate == 'http://purl.org/dc/terms/source',
    )
    .map((t) => t.object);

  const simpleAttachments = triples
    .filter(
      (t) =>
        t.subject == submittedDocument &&
        t.predicate == 'http://data.europa.eu/eli/ontology#related_to',
    )
    .map((t) => t.object);

  return [
    ...allAttachments,
    ...attachmentsAsSourceOfDecisions,
    ...simpleAttachments,
  ];
}

/**
 * @param {string} submittedDocument
 * @param {string} fileUri the local (physical) downloaded HTML file
 * @param {string} remoteDataObject the publication's remote data object
 * @param {Array<Triple>} triples harvested RDFa
 * @param {string} documentUrl the publication URL
 * @returns {Promise<Triple[]>}
 */
export async function enrichSubmission(
  submittedDocument,
  fileUri,
  remoteDataObject,
  triples,
  documentUrl,
) {
  let enrichments = [];

  if (triples?.length) {
    const expandedSkos = await expandSkosTree(triples);
    console.log(
      `Enrich submission with ${expandedSkos.length} triples by expanding SKOS tree.`,
    );
    enrichments = enrichments.concat(expandedSkos);
  }

  const submissionUrlField = addSubmissionUrl(
    submittedDocument,
    fileUri,
    remoteDataObject,
    documentUrl,
  );
  console.log(
    `Enrich submission with ${submissionUrlField.length} triples by adding the URL field.`,
  );
  enrichments = enrichments.concat(submissionUrlField);

  if (triples?.length) {
    const classificationFields = await addClassifications(
      submittedDocument,
      triples,
    );
    console.log(
      `Enrich submission with ${classificationFields.length} triples by adding the orgaan and eenheid classifications.`,
    );
    enrichments = enrichments.concat(classificationFields);
  }

  if (triples?.length && (await isVGC(triples))) {
    const expandedPath = expandDecisionToMeetingPath(triples);
    console.log(
      `Enrich submission with ${expandedPath.length} triples by expanding the path to the meeting's date.`,
    );
    enrichments = enrichments.concat(expandedPath);
  }

  return enrichments;
}

/** Enriches with a link between the submission and a discovered attachment. */
export function enrichWithAttachmentInfo(
  submittedDocument,
  attachmentRemoteDataObject,
  url,
) {
  const triples = translateRemoteUrlToSourceTriples(
    submittedDocument,
    attachmentRemoteDataObject,
    url,
  );
  console.log(
    `Enrich submission with ${triples.length} triples by adding the URL field for an attachment`,
  );
  return triples;
}

/**
 * Explicitly add each harvested type's broader SKOS types as triples -- e.g. a
 * "Belastingsreglement" is also a "Reglement en verordening".
 */
async function expandSkosTree(triples) {
  // Query each type once, however many subjects share it.
  const subjectsByType = new Map();
  for (const t of triples) {
    if (t.predicate !== 'a') continue;
    if (!subjectsByType.has(t.object)) subjectsByType.set(t.object, []);
    subjectsByType.get(t.object).push(t.subject);
  }

  const enrichments = [];
  for (const [typeUri, subjects] of subjectsByType) {
    const result = await query(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT DISTINCT ?parent WHERE {
        GRAPH <http://mu.semte.ch/graphs/public> {
          <${typeUri}> a skos:Concept, rdfs:Class ; skos:broader+ ?parent .
          ?parent a rdfs:Class .
        }
      }`);
    for (const binding of result.results.bindings) {
      for (const subject of subjects) {
        enrichments.push(
          new Triple({
            subject,
            predicate: 'a',
            object: binding.parent.value,
            datatype: RESOURCE_DATATYPE,
          }),
        );
      }
    }
  }
  return enrichments;
}

/**
 * Link the submitted document to a remote data object; pre-fills the form's "link"
 * field. Used for the publication and for each attachment.
 */
function translateRemoteUrlToSourceTriples(
  submittedDocument,
  remoteDataObject,
  documentUrl,
) {
  return [
    new Triple({
      subject: submittedDocument,
      predicate: 'http://purl.org/dc/terms/hasPart',
      object: remoteDataObject,
      datatype: RESOURCE_DATATYPE,
    }),
    new Triple({
      subject: remoteDataObject,
      predicate: 'http://www.semanticdesktop.org/ontologies/2007/01/19/nie#url',
      object: documentUrl,
    }),
    new Triple({
      subject: remoteDataObject,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object:
        'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#RemoteDataObject',
      datatype: RESOURCE_DATATYPE,
    }),
  ];
}

function addSubmissionUrl(
  submittedDocument,
  fileUri,
  remoteDataObject,
  documentUrl,
) {
  const enrichments = translateRemoteUrlToSourceTriples(
    submittedDocument,
    remoteDataObject,
    documentUrl,
  );
  enrichments.push(
    new Triple({
      subject: fileUri,
      predicate:
        'http://www.semanticdesktop.org/ontologies/2007/01/19/nie#dataSource',
      object: remoteDataObject,
      datatype: RESOURCE_DATATYPE,
    }),
  );
  return enrichments;
}

/** Adds the classifications of the bestuursorgaan and bestuurseenheid. */
async function addClassifications(submittedDocument, triples) {
  const bestuursorgaan = triples.find(
    (t) =>
      t.predicate ===
      'http://data.vlaanderen.be/ns/mandaat#isTijdspecialisatieVan',
  )?.object;
  if (!bestuursorgaan) return [];

  const result = await query(`
    PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
    SELECT ?bestuursorgaanClassification ?bestuurseenheid ?bestuurseenheidClassification WHERE {
      GRAPH ?g {
        <${bestuursorgaan}> besluit:classificatie ?bestuursorgaanClassification ;
          besluit:bestuurt ?bestuurseenheid .
        ?bestuurseenheid besluit:classificatie ?bestuurseenheidClassification .
      }
    } LIMIT 1`);
  if (!result.results.bindings.length) return [];

  const {
    bestuursorgaanClassification,
    bestuurseenheid,
    bestuurseenheidClassification,
  } = result.results.bindings[0];
  return [
    new Triple({
      subject: bestuursorgaan,
      predicate: 'http://data.vlaanderen.be/ns/besluit#bestuurt',
      object: bestuurseenheid.value,
      datatype: RESOURCE_DATATYPE,
    }),
    new Triple({
      subject: bestuursorgaan,
      predicate: 'http://data.vlaanderen.be/ns/besluit#classificatie',
      object: bestuursorgaanClassification.value,
      datatype: RESOURCE_DATATYPE,
    }),
    new Triple({
      subject: bestuurseenheid.value,
      predicate: 'http://data.vlaanderen.be/ns/besluit#classificatie',
      object: bestuurseenheidClassification.value,
      datatype: RESOURCE_DATATYPE,
    }),
  ];
}

async function isVGC(triples) {
  const passedBy = triples.find(
    (t) => t.predicate === 'http://data.europa.eu/eli/ontology#passed_by',
  );
  if (!passedBy) return false;

  const vgcClassification =
    'http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/d90c511e-f827-488c-84ba-432c8f69561c';
  const result = await query(`
    ASK {
      GRAPH <http://mu.semte.ch/graphs/public> {
        <${passedBy.object}> <http://data.vlaanderen.be/ns/mandaat#isTijdspecialisatieVan> ?orgaan .
        ?orgaan <http://data.vlaanderen.be/ns/besluit#bestuurt> ?eenheid .
        ?eenheid <http://data.vlaanderen.be/ns/besluit#classificatie> <${vgcClassification}> .
      }
    }`);
  return result.boolean;
}

/** VGC uses an adapted model in their submissions; expand the path to the meeting date. */
function expandDecisionToMeetingPath(triples) {
  let enrichments = [];
  const decisions = triples.filter(
    (t) => t.object === 'http://data.vlaanderen.be/ns/besluit#Besluit',
  );
  const meeting = triples.find(
    (t) => t.object === 'http://data.vlaanderen.be/ns/besluit#Zitting',
  )?.subject;

  for (const decision of decisions) {
    const behandelingVanAgendapuntId = uuid();
    const behandelingVanAgendapunt = `http://data.lblod.info/id/behandelingen-van-agendapunt/${behandelingVanAgendapuntId}`;
    const agendapuntId = uuid();
    const agendapunt = `http://data.lblod.info/id/agendapunten/${agendapuntId}`;

    enrichments = enrichments.concat([
      new Triple({
        subject: behandelingVanAgendapunt,
        predicate: 'http://www.w3.org/ns/prov#generated',
        object: decision.subject,
        datatype: RESOURCE_DATATYPE,
      }),
      new Triple({
        subject: behandelingVanAgendapunt,
        predicate: 'a',
        object: 'http://data.vlaanderen.be/ns/besluit#BehandelingVanAgendapunt',
        datatype: RESOURCE_DATATYPE,
      }),
      new Triple({
        subject: behandelingVanAgendapunt,
        predicate: 'http://mu.semte.ch/vocabularies/core/uuid',
        object: behandelingVanAgendapuntId,
        datatype: 'http://www.w3.org/2001/XMLSchema#string',
      }),
      new Triple({
        subject: behandelingVanAgendapunt,
        predicate: 'http://purl.org/dc/terms/subject',
        object: agendapunt,
        datatype: RESOURCE_DATATYPE,
      }),
      new Triple({
        subject: agendapunt,
        predicate: 'a',
        object: 'http://data.vlaanderen.be/ns/besluit#BehandelingVanAgendapunt',
        datatype: RESOURCE_DATATYPE,
      }),
      new Triple({
        subject: agendapunt,
        predicate: 'http://mu.semte.ch/vocabularies/core/uuid',
        object: agendapuntId,
        datatype: 'http://www.w3.org/2001/XMLSchema#string',
      }),
      new Triple({
        subject: meeting,
        predicate: 'http://data.vlaanderen.be/ns/besluit#behandelt',
        object: agendapunt,
        datatype: RESOURCE_DATATYPE,
      }),
    ]);
  }

  return enrichments;
}
