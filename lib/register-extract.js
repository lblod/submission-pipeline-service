import { DataFactory, Store, Writer } from 'n3';
const { namedNode } = DataFactory;

/**
 * Lookups over a parsed request body. Pure functions, no I/O.
 */

const RDF_TYPE = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const MEB_SUBMISSION = namedNode(
  'http://rdf.myexperiment.org/ontologies/base/Submission',
);
const DCT_SUBJECT = namedNode('http://purl.org/dc/terms/subject');
const PROV_AT_LOCATION = namedNode('http://www.w3.org/ns/prov#atLocation');
const PAV_PROVIDED_BY = namedNode('http://purl.org/pav/providedBy');
const PAV_CREATED_BY = namedNode('http://purl.org/pav/createdBy');
const MU_ACCOUNT_KEY = namedNode('http://mu.semte.ch/vocabularies/account/key');
const ADMS_STATUS = namedNode('http://www.w3.org/ns/adms#status');
const DGFT_SEC_TARGET_AUTH_CONF = namedNode(
  'http://lblod.data.gift/vocabularies/security/targetAuthenticationConfiguration',
);

/** The submission's own URI (the `@id` of the request body, typed meb:Submission). */
export function extractMeldingUri(store) {
  return store.getSubjects(RDF_TYPE, MEB_SUBMISSION, null)[0]?.value;
}

/** dct:subject of the submission -- the document being submitted about. */
export function findSubmittedResource(store) {
  return store.getObjects(null, DCT_SUBJECT, null)[0]?.value;
}

/** prov:atLocation -- the publication URL to download. */
export function extractLocationUrl(store) {
  return store.getObjects(null, PROV_AT_LOCATION, null)[0]?.value;
}

/** The properties needed to validate and register a submission. */
export function extractInfoForRegister(store) {
  return {
    href: extractLocationUrl(store),
    submittedResource: findSubmittedResource(store),
    status: store.getObjects(null, ADMS_STATUS, null)[0]?.value,
    authenticationConfiguration: store.getObjects(
      null,
      DGFT_SEC_TARGET_AUTH_CONF,
      null,
    )[0]?.value,
  };
}

/** Vendor, organisation and key, for authorisation. */
export function extractAuthentication(store) {
  return {
    key: store.getObjects(null, MU_ACCOUNT_KEY, null)[0]?.value,
    vendor: store.getObjects(null, PAV_PROVIDED_BY, null)[0]?.value,
    organisation: store.getObjects(null, PAV_CREATED_BY, null)[0]?.value,
  };
}

/**
 * The request's triples as N-Quads, minus every triple about the vendor (which holds
 * the vendor key and must not be persisted).
 *
 * @param {Store} store
 * @returns {Promise<string>}
 */
export async function storeToTurtle(store) {
  const vendor = store.getObjects(null, PAV_PROVIDED_BY, null)[0];
  const storeCopy = new Store();
  storeCopy.addQuads([...store]);
  if (vendor)
    storeCopy.removeQuads(storeCopy.getQuads(vendor, null, null, null));
  const writer = new Writer({ format: 'application/n-quads' });
  storeCopy.forEach((quad) => writer.addQuad(quad));
  return new Promise((resolve, reject) => {
    writer.end((error, result) => (error ? reject(error) : resolve(result)));
  });
}
