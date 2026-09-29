import {
  ensureValidContentType,
  ensureValidDataType,
  ensureMinimalRegisterPayload,
  ensureValidRegisterProperties,
  httpError,
} from './validation.js';
import { enrichBodyForRegister, jsonLdToStore } from './jsonld-input.js';
import { extractInfoForRegister } from './register-extract.js';
import { ensureAuthorisation } from './auth.js';
import { resolveSubmissionGraph, SEND_ALERT_CLIENT_ERRORS } from './config.js';
import { isSubmitted } from './register.js';
import { submitPipeline } from './pipeline.js';
import { reportError } from './errors.js';

/**
 * `POST /melding`: same request, response and error codes as
 * automatic-submission-service.
 */
export async function meldingHandler(req, res) {
  try {
    ensureValidContentType(req.get('content-type'));
    ensureValidDataType(req.body);

    const enrichedBody = await enrichBodyForRegister(req.body);
    const store = await jsonLdToStore(enrichedBody);
    const extracted = extractInfoForRegister(store);
    ensureMinimalRegisterPayload(extracted);
    ensureValidRegisterProperties(extracted);

    const { organisationId } = await ensureAuthorisation(store);
    const submissionGraph = resolveSubmissionGraph(organisationId);

    await ensureNotSubmitted(extracted.submittedResource);

    const { submissionUri, jobUri } = await submitPipeline({
      store,
      submissionGraph,
    });
    res
      .status(201)
      .send({ uri: submissionUri, submission: submissionUri, job: jobUri });
  } catch (e) {
    console.error(e.message);
    if (!e.alreadyStoredError) {
      const detail = JSON.stringify(
        { err: e.message, req: cleanseRequestBody(req.body) },
        undefined,
        2,
      );
      if (e.errorCode >= 500 || SEND_ALERT_CLIENT_ERRORS) {
        await reportError({
          message:
            'Something unexpected went wrong while processing an auto-submission request.',
          detail,
          reference: e.reference,
        });
      }
    }
    res
      .status(e.errorCode || 500)
      .send(
        e.errorBody ||
          `An error happened while processing the auto-submission request. If this keeps occurring for no good reason, please contact us at digitaalABB@vlaanderen.be. Please consult the technical error below.\n${e.message}`,
      );
  }
}

async function ensureNotSubmitted(submittedResource) {
  if (await isSubmitted(submittedResource)) {
    throw httpError(
      409,
      `The given submittedResource <${submittedResource}> has already been submitted.`,
    );
  }
}

/** Strip anything secret before an error report or log line might include it. */
function cleanseRequestBody(body) {
  const cleansed = body;
  if (cleansed?.authentication) delete cleansed.authentication;
  if (cleansed?.publisher?.key) delete cleansed.publisher.key;
  return cleansed;
}
