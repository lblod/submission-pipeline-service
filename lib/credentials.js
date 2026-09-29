import { uuid, sparqlEscapeUri } from 'mu';
import { query, update, parseResult } from './sparql-helpers.js';
import { PREFIXES, SECURITY_SCHEMES } from './constants.js';

/**
 * Clone the authentication configuration (basic auth or oauth2) attached to
 * `sourceUri` onto `targetUri`. Every download gets its own copy because secrets are
 * deleted once a download finishes (REMOVE_AUTHENTICATION_SECRETS_AFTER_DOWNLOAD),
 * while attachments discovered later still need them.
 *
 * @param {object} params
 * @param {string} params.targetUri the new remote data object to attach credentials to
 * @param {string} params.sourceUri the submission (or other resource) whose
 *   dgftSec:targetAuthenticationConfiguration is the credentials source
 * @param {string} params.graph
 * @returns {Promise<{newAuthConf: string, newConf: string, newCreds: string}|undefined>}
 *   undefined if `sourceUri` has no authentication configuration at all (nothing to
 *   clone, not an error)
 */
export async function cloneAuthenticationConfiguration({
  targetUri,
  sourceUri,
  graph,
}) {
  const getInfoQuery = `
    ${PREFIXES}
    SELECT DISTINCT ?secType ?authenticationConfiguration WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(sourceUri)}
          dgftSec:targetAuthenticationConfiguration ?authenticationConfiguration .
        ?authenticationConfiguration dgftSec:securityConfiguration/rdf:type ?secType .
      }
    }
  `;
  const authData = parseResult(await query(getInfoQuery))[0];
  if (!authData) return undefined;

  const newAuthConf = `http://data.lblod.info/authentications/${uuid()}`;
  const newConf = `http://data.lblod.info/configurations/${uuid()}`;
  const newCreds = `http://data.lblod.info/credentials/${uuid()}`;

  let secretsTemplate;
  let sourceSecretsTemplate;
  if (authData.secType === SECURITY_SCHEMES.basicAuth) {
    secretsTemplate = `${sparqlEscapeUri(newCreds)} meb:username ?user ; muAccount:password ?pass .`;
    sourceSecretsTemplate =
      '?srcSecrets meb:username ?user ; muAccount:password ?pass .';
  } else if (authData.secType === SECURITY_SCHEMES.oauth2) {
    secretsTemplate = `${sparqlEscapeUri(newCreds)} dgftOauth:clientId ?clientId ; dgftOauth:clientSecret ?clientSecret .`;
    sourceSecretsTemplate =
      '?srcSecrets dgftOauth:clientId ?clientId ; dgftOauth:clientSecret ?clientSecret .';
  } else {
    throw new Error(`Unsupported security type ${authData.secType}`);
  }

  await update(`
    ${PREFIXES}
    INSERT {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(targetUri)}
          dgftSec:targetAuthenticationConfiguration ${sparqlEscapeUri(newAuthConf)} .
        ${sparqlEscapeUri(newAuthConf)}
          dgftSec:secrets ${sparqlEscapeUri(newCreds)} ;
          dgftSec:securityConfiguration ${sparqlEscapeUri(newConf)} .
        ${sparqlEscapeUri(newConf)} ?srcConfP ?srcConfO .
        ${secretsTemplate}
      }
    }
    WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(authData.authenticationConfiguration)}
          dgftSec:securityConfiguration ?srcConfg ;
          dgftSec:secrets ?srcSecrets .
        ?srcConfg ?srcConfP ?srcConfO .
        ${sourceSecretsTemplate}
      }
    }
  `);

  return { newAuthConf, newConf, newCreds };
}

/**
 * Delete the secrets of an authentication configuration, keeping the configuration
 * itself.
 *
 * @param {string} authenticationConfigurationUri
 */
export async function cleanCredentials(authenticationConfigurationUri) {
  await update(`
    ${PREFIXES}
    DELETE {
      GRAPH ?g {
        ?secrets ?secretsP ?secretsO .
      }
    }
    WHERE {
      GRAPH ?g {
        ${sparqlEscapeUri(authenticationConfigurationUri)} dgftSec:secrets ?secrets .
        ?secrets ?secretsP ?secretsO .
      }
    }
  `);
}
