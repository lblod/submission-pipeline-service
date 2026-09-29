import {
  uuid,
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeInt,
  sparqlEscapeDateTime,
} from 'mu';
import { query, update, parseResult } from './sparql-helpers.js';
import {
  PREFIXES,
  DOWNLOAD_STATUSES,
  SECURITY_SCHEMES,
  CREATORS,
} from './constants.js';

/**
 * SPARQL queries for downloading remote data objects, shared by the publication
 * download and attachment downloads.
 */

/**
 * Headers to send and, if any, the security scheme type of the object's cloned
 * authentication configuration.
 *
 * @returns {Promise<{headers: Array<{name: string, value: string}>, credentialsType: string|undefined}>}
 */
export async function getDownloadContext(remoteDataObjectUri, graph) {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?headerName ?headerValue ?securityConfigurationType WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        OPTIONAL {
          ${sparqlEscapeUri(remoteDataObjectUri)} rpioHttp:requestHeader ?header .
          ?header http:fieldValue ?headerValue ; http:fieldName ?headerName .
        }
        OPTIONAL {
          ${sparqlEscapeUri(remoteDataObjectUri)}
            dgftSec:targetAuthenticationConfiguration ?authenticationConf .
          ?authenticationConf dgftSec:securityConfiguration/rdf:type ?securityConfigurationType .
          VALUES ?securityConfigurationType {
            ${sparqlEscapeUri(SECURITY_SCHEMES.basicAuth)}
            ${sparqlEscapeUri(SECURITY_SCHEMES.oauth2)}
          }
        }
      }
    }
  `);
  const rows = parseResult(result);
  const headers = rows
    .filter((r) => r.headerName)
    .map((r) => ({ name: r.headerName, value: r.headerValue }));
  return { headers, credentialsType: rows[0]?.securityConfigurationType };
}

export async function getBasicCredentials(remoteDataObjectUri, graph) {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?user ?pass WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)}
          dgftSec:targetAuthenticationConfiguration ?authenticationConf .
        ?authenticationConf dgftSec:secrets ?secrets .
        ?secrets meb:username ?user ; muAccount:password ?pass .
      }
    }
  `);
  return parseResult(result)[0];
}

export async function getOauthCredentials(remoteDataObjectUri, graph) {
  const result = await query(`
    ${PREFIXES}
    PREFIX security: <https://www.w3.org/2019/wot/security#>
    SELECT DISTINCT ?clientId ?clientSecret ?accessTokenUri ?resource ?scope WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)}
          dgftSec:targetAuthenticationConfiguration ?authenticationConf .
        ?authenticationConf
          dgftSec:secrets ?secrets ;
          dgftSec:securityConfiguration ?securityConfiguration .
        ?secrets dgftOauth:clientId ?clientId ; dgftOauth:clientSecret ?clientSecret .
        ?securityConfiguration security:token ?accessTokenUri .
        OPTIONAL { ?securityConfiguration dgftOauth:resource ?resource . }
        OPTIONAL { ?securityConfiguration dgftOauth:scope ?scope . }
      }
    }
  `);
  return parseResult(result)[0];
}

/** The authentication configuration URI attached to a remote data object, if any. */
export async function getAuthenticationConfiguration(
  remoteDataObjectUri,
  graph,
) {
  const result = await query(`
    ${PREFIXES}
    SELECT DISTINCT ?authenticationConf WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)}
          dgftSec:targetAuthenticationConfiguration ?authenticationConf .
      }
    }
  `);
  return parseResult(result)[0]?.authenticationConf;
}

export async function getDownloadEvent(downloadEventUri) {
  const result = await query(`
    ${PREFIXES}
    PREFIX ndo: <http://oscaf.sourceforge.net/ndo.html#>
    SELECT DISTINCT ?status ?numberOfRetries WHERE {
      GRAPH ?g {
        ${sparqlEscapeUri(downloadEventUri)}
          a ndo:DownloadEvent ;
          adms:status ?status ;
          task:numberOfRetries ?numberOfRetries .
      }
    }
  `);
  return parseResult(result)[0];
}

/**
 * The latest download event of a remote data object. Used by lib/reconciliation.js
 * to resume an interrupted download and to judge whether it is stale.
 *
 * @param {string} remoteDataObjectUri
 * @returns {Promise<{downloadEventUri: string, status: string, numberOfRetries: number, modified: Date}|undefined>}
 */
export async function getDownloadEventForRemoteDataObject(remoteDataObjectUri) {
  const result = await query(`
    ${PREFIXES}
    PREFIX ndo: <http://oscaf.sourceforge.net/ndo.html#>
    PREFIX nuao: <http://www.semanticdesktop.org/ontologies/2010/01/25/nuao#>
    SELECT DISTINCT ?downloadEventUri ?status ?numberOfRetries ?modified WHERE {
      GRAPH ?g {
        ?downloadEventUri
          a ndo:DownloadEvent ;
          nuao:involves ${sparqlEscapeUri(remoteDataObjectUri)} ;
          adms:status ?status ;
          task:numberOfRetries ?numberOfRetries ;
          dct:modified ?modified .
      }
    }
    ORDER BY DESC(?numberOfRetries)
    LIMIT 1
  `);
  return parseResult(result)[0];
}

/**
 * Join update statements into one request, skipping empty ones. Attachments pass no
 * task transitions.
 */
function joinStatements(...statements) {
  return statements.filter((s) => s && s.trim()).join('\n;\n');
}

/**
 * Start a download in one request: optionally move the download task to busy, set the
 * remote data object to ongoing and create an ndo:DownloadEvent.
 *
 * @returns {Promise<string>} the new download event's URI
 */
export async function startDownload({
  downloadTaskTransitionQuery = '',
  graph,
  remoteDataObjectUri,
  defaultGraph,
}) {
  const downloadEventId = uuid();
  const downloadEventUri = `http://lblod.data.gift/download-events/${downloadEventId}`;
  const nowSparql = sparqlEscapeDateTime(new Date());

  const statusAndEventStatement = `
    DELETE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ?oldStatus .
      }
    }
    WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ?oldStatus .
      }
    }
    ;
    INSERT DATA {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.ongoing)} .
      }
      GRAPH ${sparqlEscapeUri(defaultGraph)} {
        ${sparqlEscapeUri(downloadEventUri)}
          a ndo:DownloadEvent ;
          mu:uuid ${sparqlEscapeString(downloadEventId)} ;
          adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.ongoing)} ;
          task:numberOfRetries ${sparqlEscapeInt(0)} ;
          dct:created ${nowSparql} ;
          dct:modified ${nowSparql} ;
          dct:creator ${sparqlEscapeUri(CREATORS.downloadUrl)} ;
          nuao:involves ${sparqlEscapeUri(remoteDataObjectUri)} .
      }
    }`;

  await update(`
    ${PREFIXES}
    PREFIX ndo: <http://oscaf.sourceforge.net/ndo.html#>
    PREFIX nuao: <http://www.semanticdesktop.org/ontologies/2010/01/25/nuao#>
    ${joinStatements(downloadTaskTransitionQuery, statusAndEventStatement)}
  `);

  return downloadEventUri;
}

/**
 * Set the download event back to ongoing with a new retry count. `dct:modified` is
 * what reconciliation uses to tell a retrying download from a stuck one.
 */
export async function retryDownloadEvent(downloadEventUri, numberOfRetries) {
  await update(`
    ${PREFIXES}
    DELETE {
      GRAPH ?g {
        ${sparqlEscapeUri(downloadEventUri)}
          adms:status ?status ;
          task:numberOfRetries ?oldRetries ;
          dct:modified ?oldModified .
      }
    }
    INSERT {
      GRAPH ?g {
        ${sparqlEscapeUri(downloadEventUri)}
          adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.ongoing)} ;
          task:numberOfRetries ${sparqlEscapeInt(numberOfRetries)} ;
          dct:modified ${sparqlEscapeDateTime(new Date())} .
      }
    }
    WHERE {
      GRAPH ?g {
        ${sparqlEscapeUri(downloadEventUri)}
          adms:status ?status ;
          task:numberOfRetries ?oldRetries ;
          dct:modified ?oldModified .
      }
    }
  `);
}

/** Mark one failed attempt on the download event. */
export async function markDownloadEventAttemptFailed(downloadEventUri) {
  await update(`
    ${PREFIXES}
    DELETE {
      GRAPH ?g {
        ${sparqlEscapeUri(downloadEventUri)} adms:status ?status ; dct:modified ?oldModified .
      }
    }
    INSERT {
      GRAPH ?g {
        ${sparqlEscapeUri(downloadEventUri)}
          adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.failure)} ;
          dct:modified ${sparqlEscapeDateTime(new Date())} .
      }
    }
    WHERE {
      GRAPH ?g {
        ${sparqlEscapeUri(downloadEventUri)} adms:status ?status ; dct:modified ?oldModified .
      }
    }
  `);
}

export async function saveHttpStatusCode(
  remoteDataObjectUri,
  graph,
  statusCode,
) {
  await update(`
    ${PREFIXES}
    DELETE { GRAPH ${sparqlEscapeUri(graph)} { ?url ext:httpStatusCode ?code . } }
    WHERE {
      BIND(${sparqlEscapeUri(remoteDataObjectUri)} as ?url)
      GRAPH ${sparqlEscapeUri(graph)} { ?url ext:httpStatusCode ?code . }
    }
    ;
    INSERT DATA {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)} ext:httpStatusCode ${sparqlEscapeInt(statusCode)} .
      }
    }
  `);
}

export async function saveCacheError(remoteDataObjectUri, graph, error) {
  await update(`
    ${PREFIXES}
    DELETE { GRAPH ${sparqlEscapeUri(graph)} { ?url ext:cacheError ?msg . } }
    WHERE {
      BIND(${sparqlEscapeUri(remoteDataObjectUri)} as ?url)
      GRAPH ${sparqlEscapeUri(graph)} { ?url ext:cacheError ?msg . }
    }
    ;
    INSERT DATA {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)} ext:cacheError ${sparqlEscapeString(error.toString())} .
      }
    }
  `);
}

export async function createPhysicalFileDataObject({
  physicalUri,
  dataSourceUri,
  graph,
  name,
  format,
  fileSize,
  extension,
  created,
}) {
  if (!physicalUri.startsWith('share://')) {
    throw new Error('File URI should start with share://');
  }
  const id = uuid();
  await update(`
    ${PREFIXES}
    PREFIX ndo: <http://oscaf.sourceforge.net/ndo.html#>
    INSERT DATA {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(physicalUri)}
          a nfo:FileDataObject, nfo:LocalFileDataObject ;
          nfo:fileName ${sparqlEscapeString(name)} ;
          nie:dataSource ${sparqlEscapeUri(dataSourceUri)} ;
          ndo:copiedFrom ${sparqlEscapeUri(dataSourceUri)} ;
          mu:uuid ${sparqlEscapeString(id)} ;
          dct:format ${sparqlEscapeString(format)} ;
          nfo:fileSize ${sparqlEscapeInt(fileSize)} ;
          dbpedia:fileExtension ${sparqlEscapeString(extension)} ;
          dct:created ${sparqlEscapeDateTime(created)} .
      }
    }
  `);
}

/**
 * Mark a download successful in one request: the remote data object and download
 * event go to success, the physical file's metadata is copied onto the remote data
 * object, and the optional task transition is applied.
 */
export async function completeDownloadSuccess({
  graph,
  defaultGraph,
  remoteDataObjectUri,
  physicalFileUri,
  downloadEventUri,
  taskTransitionQuery = '',
}) {
  const statusAndMetadataStatement = `
    DELETE {
      GRAPH ${sparqlEscapeUri(graph)} { ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ?oldStatus . }
    }
    WHERE {
      GRAPH ${sparqlEscapeUri(graph)} { ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ?oldStatus . }
    }
    ;
    INSERT DATA {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.success)} .
      }
      GRAPH ${sparqlEscapeUri(defaultGraph)} {
        ${sparqlEscapeUri(downloadEventUri)}
          adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.success)} ;
          nuao:involves ${sparqlEscapeUri(physicalFileUri)} .
      }
    }
    ;
    INSERT {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)}
          a nfo:FileDataObject ;
          nfo:fileName ?filename ;
          dct:format ?format ;
          nfo:fileSize ?fileSize ;
          dbpedia:fileExtension ?fileExtension ;
          dct:created ?created .
      }
    }
    WHERE {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(physicalFileUri)}
          a nfo:FileDataObject ;
          nfo:fileName ?filename ;
          dct:format ?format ;
          nfo:fileSize ?fileSize ;
          dbpedia:fileExtension ?fileExtension ;
          dct:created ?created .
      }
    }`;

  await update(`
    ${PREFIXES}
    PREFIX nuao: <http://www.semanticdesktop.org/ontologies/2010/01/25/nuao#>
    ${joinStatements(taskTransitionQuery, statusAndMetadataStatement)}
  `);
}

/**
 * Mark a download permanently failed in one request: the remote data object and
 * download event go to failure, and the optional task/job transitions are applied.
 */
export async function completeDownloadFailure({
  graph,
  defaultGraph,
  remoteDataObjectUri,
  downloadEventUri,
  taskTransitionQuery = '',
  jobTransitionQuery = '',
}) {
  const statusStatement = `
    DELETE {
      GRAPH ${sparqlEscapeUri(graph)} { ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ?oldStatus . }
    }
    WHERE {
      GRAPH ${sparqlEscapeUri(graph)} { ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ?oldStatus . }
    }
    ;
    INSERT DATA {
      GRAPH ${sparqlEscapeUri(graph)} {
        ${sparqlEscapeUri(remoteDataObjectUri)} adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.failure)} .
      }
      GRAPH ${sparqlEscapeUri(defaultGraph)} {
        ${sparqlEscapeUri(downloadEventUri)} adms:status ${sparqlEscapeUri(DOWNLOAD_STATUSES.failure)} .
      }
    }`;

  await update(`
    ${PREFIXES}
    ${joinStatements(taskTransitionQuery, jobTransitionQuery, statusStatement)}
  `);
}
