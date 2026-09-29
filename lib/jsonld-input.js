import { uuid } from 'mu';
import jsonld from 'jsonld';
import { Store } from 'n3';
import { SUBMISSION_STATUSES } from './constants.js';
import { httpError } from './validation.js';
import { loadPublicJsonLd } from './context-loader.js';

/**
 * JSON-LD <-> N3 Store conversion and request-body enrichment.
 */

/**
 * The JSON-LD context vendors build requests against
 * (https://lblod.data.gift/contexts/automatische-melding/v1/context.json). Must not
 * change.
 *
 * `submittedResource` (/melding) and `submission` (/status) both map to dct:subject
 * on purpose: the endpoints share this context.
 */
const SubmissionRegistrationContext = {
  prov: 'http://www.w3.org/ns/prov#',
  dct: 'http://purl.org/dc/terms/',
  muAccount: 'http://mu.semte.ch/vocabularies/account/',
  dgftOauth: 'http://kanselarij.vo.data.gift/vocabularies/oauth-2.0-session/',
  dgftSec: 'http://lblod.data.gift/vocabularies/security/',
  meb: 'http://rdf.myexperiment.org/ontologies/base/',
  pav: 'http://purl.org/pav/',
  adms: 'http://www.w3.org/ns/adms#',
  wotSec: 'https://www.w3.org/2019/wot/security#',
  organization: {
    '@id': 'pav:createdBy',
    '@type': '@id',
  },
  href: {
    '@type': '@id',
    '@id': 'prov:atLocation',
  },
  submittedResource: {
    '@type': '@id',
    '@id': 'dct:subject',
  },
  key: 'muAccount:key',
  publisher: 'pav:providedBy',
  uri: {
    '@type': '@id',
    '@id': '@id',
  },
  status: {
    '@type': '@id',
    '@id': 'adms:status',
  },
  authentication: 'dgftSec:targetAuthenticationConfiguration',
  configuration: 'dgftSec:securityConfiguration',
  credentials: 'dgftSec:secrets',
  acceptedBy: 'dgftSec:acceptedBy',
  oauth2: {
    '@type': '@id',
    '@id': 'wotSec:OAuth2SecurityScheme',
  },
  basic: {
    '@type': '@id',
    '@id': 'wotSec:BasicSecurityScheme',
  },
  flow: 'wotSec:flow',
  token: 'wotSec:token',
  scheme: {
    '@id': '@type',
    '@type': '@vocab',
  },
  resource: 'dgftOauth:resource',
  clientId: 'dgftOauth:clientId',
  clientSecret: 'dgftOauth:clientSecret',
  username: 'meb:username',
  password: 'muAccount:password',
  submission: {
    '@type': '@id',
    '@id': 'dct:subject',
  },
  scope: 'dgftOauth:scope',
};

const PUBLISHED_CONTEXT_URLS = [
  'https://lblod.data.gift/contexts/automatische-melding/v1/context.json',
  'http://lblod.data.gift/contexts/automatische-melding/v1/context.json',
];

/**
 * Serves the published context from memory (its URL no longer serves JSON-LD) and
 * fetches other remote contexts from public hosts only, so a request body can't make
 * the service call internal services.
 */
async function documentLoader(url) {
  if (PUBLISHED_CONTEXT_URLS.includes(url)) {
    return {
      contextUrl: null,
      documentUrl: url,
      document: { '@context': SubmissionRegistrationContext },
    };
  }
  try {
    return await loadPublicJsonLd(url);
  } catch (e) {
    // The detail stays in the log: it can reveal internal addresses.
    console.warn(`Could not load JSON-LD context <${url}>: ${e.message}`);
    throw httpError(400, `Could not load the JSON-LD context <${url}>.`);
  }
}

/**
 * Add the @id, @context, @type and default status a /melding body needs before it is
 * converted to RDF. Mutates and returns `originalBody`.
 */
export async function enrichBodyForRegister(originalBody) {
  if (!originalBody['@type']) {
    originalBody['@type'] = 'meb:Submission';
  }
  if (!originalBody['@context']) {
    originalBody['@context'] = SubmissionRegistrationContext;
  }
  const id = uuid();
  originalBody['http://mu.semte.ch/vocabularies/core/uuid'] = id;
  if (!originalBody['@id']) {
    originalBody['@id'] = `http://data.lblod.info/submissions/${id}`;
  }
  if (!originalBody.status) {
    originalBody.status = SUBMISSION_STATUSES.concept;
  }
  if (originalBody.authentication) {
    originalBody.authentication['@id'] =
      `http://data.lblod.info/authentications/${uuid()}`;
    originalBody.authentication.configuration['@id'] =
      `http://data.lblod.info/configurations/${uuid()}`;
    originalBody.authentication.credentials['@id'] =
      `http://data.lblod.info/credentials/${uuid()}`;
  }
  return originalBody;
}

/** Same scaffolding, for /status requests. */
export async function enrichBodyForStatus(body) {
  if (!body['@context']) {
    body['@context'] = SubmissionRegistrationContext;
  }
  const requestId = uuid();
  if (!body['@id']) {
    body['@id'] =
      `http://data.lblod.info/submission-status-request/${requestId}`;
  }
  if (!body['@type']) {
    body['@type'] = 'http://data.lblod.info/submission-status-request/Request';
  }
  if (body.authentication) {
    body.authentication['@id'] =
      `http://data.lblod.info/authentications/${uuid()}`;
    body.authentication.configuration['@id'] =
      `http://data.lblod.info/configurations/${uuid()}`;
    body.authentication.credentials['@id'] =
      `http://data.lblod.info/credentials/${uuid()}`;
  }
  return body;
}

/** @returns {Promise<Store>} */
export async function jsonLdToStore(jsonLdObject) {
  let quads;
  try {
    quads = await jsonld.toRDF(jsonLdObject, { documentLoader });
  } catch (e) {
    // jsonld wraps the documentLoader's error; surface its 400.
    throw e.details?.cause?.errorCode ? e.details.cause : e;
  }
  const store = new Store();
  store.addQuads(quads);
  return store;
}

/**
 * @param {Store|Array} store
 * @param {object} context JSON-LD context to compact with
 * @param {object} frame JSON-LD frame to shape the output with
 */
export async function storeToJsonLd(store, context, frame) {
  const expanded = await jsonld.fromRDF([...store], {});
  const framed = await jsonld.frame(expanded, frame, { documentLoader });
  return jsonld.compact(framed, context, { documentLoader });
}
