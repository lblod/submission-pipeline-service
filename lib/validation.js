import { SUBMISSION_STATUSES } from './constants.js';

/**
 * Request validation for /melding and /status. Pure functions, no I/O.
 */

/**
 * An Error carrying the HTTP status and JSON body the route handlers respond with.
 *
 * @param {number} code HTTP status code
 * @param {string} message
 * @returns {Error} with `.errorCode` and `.errorBody` set, ready to `throw`
 */
export function httpError(code, message) {
  const err = new Error(message);
  err.errorCode = code;
  err.errorBody = { errors: [{ title: message }] };
  return err;
}

export function ensureValidContentType(contentType) {
  if (!/application\/(ld\+)?json/.test(contentType || '')) {
    throw httpError(
      400,
      'Content-Type not valid, only application/json or application/ld+json are accepted',
    );
  }
}

export function ensureValidDataType(body) {
  if (Array.isArray(body)) {
    throw httpError(
      400,
      'Invalid JSON payload, expected an object but found array.',
    );
  }
}

/**
 * @param {object} extracted the shape returned by register-extract.js's
 *   extractInfoForRegister
 */
export function ensureMinimalRegisterPayload(extracted) {
  for (const prop in extracted) {
    if (!extracted[prop] && prop !== 'authenticationConfiguration') {
      throw httpError(
        400,
        `Invalid JSON-LD payload: property "${prop}" is missing or invalid.`,
      );
    }
  }
}

/**
 * @param {object} extracted
 * @returns {{isValid: boolean, errors: Array<{message: string}>}}
 */
export function validateExtractedInfo(extracted) {
  const errors = [];
  if (
    extracted.status !== SUBMISSION_STATUSES.concept &&
    extracted.status !== SUBMISSION_STATUSES.submittable
  ) {
    errors.push({ message: 'Property status is not valid.' });
  }
  return { isValid: errors.length === 0, errors };
}

export function ensureValidRegisterProperties(extracted) {
  const { isValid, errors } = validateExtractedInfo(extracted);
  if (!isValid) {
    const err = new Error(
      `Some given properties are invalid:\n${errors.map((e) => e.message).join('\n')}`,
    );
    err.errorCode = 400;
    err.errorBody = { errors };
    throw err;
  }
}

export function ensureAuthenticationPresent(authentication) {
  if (!(
    authentication.vendor &&
    authentication.key &&
    authentication.organisation
  )) {
    throw httpError(
      400,
      'The authentication (or part of it) for this request is missing. Make sure to supply publisher (with vendor URI and key) and organization information to the request.',
    );
  }
}
