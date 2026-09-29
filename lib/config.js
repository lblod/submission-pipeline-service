import env from 'env-var';

/**
 * Environment-driven configuration. Fixed vocabulary lives in lib/constants.js.
 */

export const GRAPH_TEMPLATE = env
  .get('GRAPH_TEMPLATE')
  .default(
    'http://mu.semte.ch/graphs/organizations/~ORGANIZATION_ID~/LoketLB-toezichtGebruiker',
  )
  .asUrlString();

(function checkGraphTemplate() {
  if (!/~ORGANIZATION_ID~/.test(GRAPH_TEMPLATE)) {
    throw new Error(
      `The GRAPH_TEMPLATE environment variable "${GRAPH_TEMPLATE}" does not contain a "~ORGANIZATION_ID~".`,
    );
  }
})();

/** @param {string} organisationId mu:uuid of the bestuurseenheid */
export function resolveSubmissionGraph(organisationId) {
  return GRAPH_TEMPLATE.replace('~ORGANIZATION_ID~', organisationId);
}

export const SEND_ALERT_CLIENT_ERRORS = env
  .get('SEND_ALERT_CLIENT_ERRORS')
  .default('true')
  .asBool();

/** Match the vendor key against muAccount:keyHash (argon2) instead of muAccount:key. */
export const USE_HASHED_KEY = env
  .get('USE_HASHED_KEY')
  .default('false')
  .asBool();

// --- download step ---

/** Graph the ndo:DownloadEvent resources are written to. */
export const DEFAULT_GRAPH = env
  .get('DEFAULT_GRAPH')
  .default('http://mu.semte.ch/graphs/public')
  .asUrlString();

/** Download attempts before the download step fails permanently. */
export const CACHING_MAX_RETRIES = env
  .get('CACHING_MAX_RETRIES')
  .default('30')
  .asIntPositive();

/** Absolute path inside the container where downloaded files are stored. */
export const FILE_STORAGE = env
  .get('FILE_STORAGE')
  .default('/share')
  .asString();

/** Extension used for a downloaded text file whose type can't be guessed. */
export const DEFAULT_TEXT_FORMAT = env
  .get('DEFAULT_TEXT_FORMAT')
  .default('.txt')
  .asString();

/**
 * Delete cloned credentials once a download reaches a final state. The misspelled
 * name (from download-url-service) is still accepted; the correct one wins if both
 * are set.
 */
const REMOVE_SECRETS_VAR = 'REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD';
const REMOVE_SECRETS_VAR_TYPO = 'REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWLOAD';

if (process.env[REMOVE_SECRETS_VAR_TYPO] !== undefined) {
  const bothSet = process.env[REMOVE_SECRETS_VAR] !== undefined;
  console.warn(
    `[deprecated] ${REMOVE_SECRETS_VAR_TYPO} is a misspelling kept only for backwards ` +
      'compatibility with the original automatic-submission-service. Please switch to ' +
      `${REMOVE_SECRETS_VAR}; the misspelled variant may be removed in a future release.` +
      (bothSet
        ? ` Both are set right now -- ${REMOVE_SECRETS_VAR} takes precedence.`
        : ''),
  );
}

export const REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD = env
  .get(REMOVE_SECRETS_VAR)
  .default(env.get(REMOVE_SECRETS_VAR_TYPO).default('true').asString())
  .asBool();

/** Number of publications/attachments downloaded in parallel. */
export const DOWNLOAD_CONCURRENCY = env
  .get('DOWNLOAD_CONCURRENCY')
  .default('5')
  .asIntPositive();

// --- attachments ---

/** Vendor URI used to detect Vandenbroele submissions. */
export const VANDENBROELE_URI = env
  .get('VANDENBROELE_URI')
  .default(
    'http://data.lblod.info/vendors/b1e41693-639a-4f61-92a9-5b9a3e0b924e',
  )
  .asUrlString();

/** Guess attachment filenames from the submission HTML for that vendor. */
export const APPLY_VANDENBROELE_FILENAME_WORKAROUND = env
  .get('APPLY_VANDENBROELE_FILENAME_WORKAROUND')
  .default('false')
  .asBool();

// --- reconciliation ---

/** Run the reconciliation sweep once at startup. */
export const RECONCILE_ON_BOOT = env
  .get('RECONCILE_ON_BOOT')
  .default('true')
  .asBool();

/** Seconds between periodic reconciliation sweeps. `0` disables them. */
export const RECONCILE_INTERVAL = env
  .get('RECONCILE_INTERVAL')
  .default('3600')
  .asIntPositive();

/** Hours a task may sit at `js:busy` before the periodic sweep touches it. */
export const STALE_TASK_TIMEOUT_HOURS = env
  .get('STALE_TASK_TIMEOUT_HOURS')
  .default('1')
  .asIntPositive();

/**
 * Days after registration beyond which reconciliation fails a job instead of
 * resuming it, so an old backlog isn't silently processed after an incident.
 */
export const RECONCILE_ABANDON_AFTER_DAYS = env
  .get('RECONCILE_ABANDON_AFTER_DAYS')
  .default('7')
  .asIntPositive();
