import rateLimit from 'express-rate-limit';
import { ensureValidContentType } from './validation.js';
import {
  enrichBodyForStatus,
  jsonLdToStore,
  storeToJsonLd,
} from './jsonld-input.js';
import { findSubmittedResource } from './register-extract.js';
import { ensureAuthorisation } from './auth.js';
import { getSubmissionStatusRdfJS } from './submission-status.js';
import { reportError } from './errors.js';

/**
 * `POST /status`: unchanged from automatic-submission-service, including the rate
 * limit of 5 requests per minute per submission.
 *
 * A /status body's `submission` maps to dct:subject, so findSubmittedResource
 * returns the submission being asked about.
 */

async function extractSubmissionUriFromRequest(req) {
  ensureValidContentType(req.get('content-type'));
  const enrichedBody = await enrichBodyForStatus(req.body);
  const store = await jsonLdToStore(enrichedBody);
  return findSubmittedResource(store);
}

export const statusLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  message:
    'There have been too many requests about this submission. The amount of status requests is limited to 5 per minute. Try again later.',
  keyGenerator: async (req) =>
    (await extractSubmissionUriFromRequest(req)) || '',
});

export async function statusHandler(req, res) {
  try {
    ensureValidContentType(req.get('content-type'));
    const enrichedBody = await enrichBodyForStatus(req.body);
    const store = await jsonLdToStore(enrichedBody);

    await ensureAuthorisation(store);

    const submissionUri = findSubmittedResource(store);
    if (!submissionUri) {
      throw new Error('There was no submission URI in the request');
    }

    const { statusRdfJSTriples, JobStatusContext, JobStatusFrame } =
      await getSubmissionStatusRdfJS(submissionUri);
    const jsonLdObject = await storeToJsonLd(
      statusRdfJSTriples,
      JobStatusContext,
      JobStatusFrame,
    );
    res.status(200).send(jsonLdObject);
  } catch (error) {
    const message =
      'Something went wrong while fetching the status of the submitted resource and its associated Job';
    console.error(message, error.message);
    console.error(error);
    await reportError({ message, detail: error.message });
    res.status(500).send(`${message}\n${error.message}`);
  }
}
