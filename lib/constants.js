/**
 * Vocabulary shared by all steps, merged from the constants of the three services
 * this one replaces. URI values are unchanged.
 */

export const PREFIX_TABLE = {
  meb: 'http://rdf.myexperiment.org/ontologies/base/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  pav: 'http://purl.org/pav/',
  dct: 'http://purl.org/dc/terms/',
  oslc: 'http://open-services.net/ns/core#',
  melding: 'http://lblod.data.gift/vocabularies/automatische-melding/',
  lblodBesluit: 'http://lblod.data.gift/vocabularies/besluit/',
  besluit: 'http://data.vlaanderen.be/ns/besluit#',
  mandaat: 'http://data.vlaanderen.be/ns/mandaat#',
  adms: 'http://www.w3.org/ns/adms#',
  muAccount: 'http://mu.semte.ch/vocabularies/account/',
  eli: 'http://data.europa.eu/eli/ontology#',
  org: 'http://www.w3.org/ns/org#',
  elod: 'http://linkedeconomy.org/ontology#',
  nie: 'http://www.semanticdesktop.org/ontologies/2007/01/19/nie#',
  prov: 'http://www.w3.org/ns/prov#',
  mu: 'http://mu.semte.ch/vocabularies/core/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  nfo: 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dbpedia: 'http://dbpedia.org/ontology/',
  ext: 'http://mu.semte.ch/vocabularies/ext/',
  http: 'http://www.w3.org/2011/http#',
  rpioHttp: 'http://redpencil.data.gift/vocabularies/http/',
  dgftSec: 'http://lblod.data.gift/vocabularies/security/',
  dgftOauth: 'http://kanselarij.vo.data.gift/vocabularies/oauth-2.0-session/',
  wotSec: 'https://www.w3.org/2019/wot/security#',
  cogs: 'http://vocab.deri.ie/cogs#',
  asj: 'http://data.lblod.info/id/automatic-submission-job/',
  services: 'http://lblod.data.gift/services/',
  job: 'http://lblod.data.gift/jobs/',
  task: 'http://redpencil.data.gift/vocabularies/tasks/',
  js: 'http://redpencil.data.gift/id/concept/JobStatus/',
  tasko: 'http://lblod.data.gift/id/jobs/concept/TaskOperation/',
  jobo: 'http://lblod.data.gift/id/jobs/concept/JobOperation/',
  hrvst: 'http://lblod.data.gift/vocabularies/harvesting/',
  ndo: 'http://oscaf.sourceforge.net/ndo.html#',
  nuao: 'http://www.semanticdesktop.org/ontologies/2010/01/25/nuao#',
  lblodlg: 'http://data.lblod.info/vocabularies/leidinggevenden/',
};

export const PREFIXES = (() => {
  const all = [];
  for (const key in PREFIX_TABLE)
    all.push(`PREFIX ${key}: <${PREFIX_TABLE[key]}>`);
  return all.join('\n');
})();

export const GRAPHS = {
  error: 'http://mu.semte.ch/graphs/error',
  /** Vendor/organisation authorisation data lives here, not in a per-org graph. */
  automaticSubmission: 'http://mu.semte.ch/graphs/automatic-submission',
};

/** Job/task statuses (`js:` prefix). */
export const TASK_STATUSES = {
  scheduled: `${PREFIX_TABLE.js}scheduled`,
  busy: `${PREFIX_TABLE.js}busy`,
  success: `${PREFIX_TABLE.js}success`,
  failed: `${PREFIX_TABLE.js}failed`,
};
export const JOB_STATUSES = TASK_STATUSES;

/** Task operations (`tasko:` prefix), one per pipeline step. */
export const TASK_OPERATIONS = {
  register: `${PREFIX_TABLE.tasko}register`,
  download: `${PREFIX_TABLE.tasko}download`,
  import: `${PREFIX_TABLE.tasko}import`,
};

export const JOB_OPERATIONS = {
  automaticSubmissionFlow: `${PREFIX_TABLE.jobo}automaticSubmissionFlow`,
};

/**
 * `adms:status` values of `nfo:RemoteDataObject`s, as used by download-url-service.
 */
export const DOWNLOAD_STATUSES = {
  readyToBeCached:
    'http://lblod.data.gift/file-download-statuses/ready-to-be-cached',
  ongoing: 'http://lblod.data.gift/file-download-statuses/ongoing',
  success: 'http://lblod.data.gift/file-download-statuses/success',
  failure: 'http://lblod.data.gift/file-download-statuses/failure',
};

export const SECURITY_SCHEMES = {
  basicAuth: 'https://www.w3.org/2019/wot/security#BasicSecurityScheme',
  oauth2: 'https://www.w3.org/2019/wot/security#OAuth2SecurityScheme',
};

export const SUBMISSION_STATUSES = {
  concept:
    'http://lblod.data.gift/concepts/79a52da4-f491-4e2f-9374-89a13cde8ecd',
  submittable:
    'http://lblod.data.gift/concepts/f6330856-e261-430f-b949-8e510d20d0ff',
};

/**
 * `dct:creator` values, kept identical to the old services because downstream
 * queries filter on them.
 */
export const CREATORS = {
  automaticSubmission:
    'http://lblod.data.gift/services/automatic-submission-service',
  downloadUrl: 'http://lblod.data.gift/services/download-url-service',
  importSubmission: 'http://lblod.data.gift/services/import-submission-service',
};

export const JOB_PREFIX = PREFIX_TABLE.asj;
