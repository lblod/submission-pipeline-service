import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureValidContentType,
  ensureValidDataType,
  ensureMinimalRegisterPayload,
  validateExtractedInfo,
  ensureValidRegisterProperties,
  ensureAuthenticationPresent,
} from '../lib/validation.js';
import { SUBMISSION_STATUSES } from '../lib/constants.js';

test('ensureValidContentType accepts json and ld+json', () => {
  assert.doesNotThrow(() => ensureValidContentType('application/json'));
  assert.doesNotThrow(() => ensureValidContentType('application/ld+json'));
});

test('ensureValidContentType rejects anything else, with a 400', () => {
  assert.throws(
    () => ensureValidContentType('text/plain'),
    (err) => err.errorCode === 400,
  );
  assert.throws(
    () => ensureValidContentType(undefined),
    (err) => err.errorCode === 400,
  );
});

test('ensureValidDataType rejects arrays, accepts objects', () => {
  assert.throws(
    () => ensureValidDataType([]),
    (err) => err.errorCode === 400,
  );
  assert.doesNotThrow(() => ensureValidDataType({}));
});

test('ensureMinimalRegisterPayload requires href/submittedResource/status but not authenticationConfiguration', () => {
  assert.throws(
    () =>
      ensureMinimalRegisterPayload({
        href: 'x',
        submittedResource: '',
        status: 'y',
      }),
    (err) => err.errorCode === 400 && /submittedResource/.test(err.message),
  );
  assert.doesNotThrow(() =>
    ensureMinimalRegisterPayload({
      href: 'x',
      submittedResource: 'y',
      status: 'z',
      authenticationConfiguration: undefined,
    }),
  );
});

test('validateExtractedInfo accepts concept or submittable status only', () => {
  assert.equal(
    validateExtractedInfo({ status: SUBMISSION_STATUSES.concept }).isValid,
    true,
  );
  assert.equal(
    validateExtractedInfo({ status: SUBMISSION_STATUSES.submittable }).isValid,
    true,
  );
  const invalid = validateExtractedInfo({ status: 'http://example.org/bogus' });
  assert.equal(invalid.isValid, false);
  assert.match(invalid.errors[0].message, /status is not valid/);
});

test('ensureValidRegisterProperties throws 400 with all error messages joined', () => {
  assert.throws(
    () => ensureValidRegisterProperties({ status: 'http://example.org/bogus' }),
    (err) => err.errorCode === 400 && err.errorBody.errors.length === 1,
  );
});

test('ensureAuthenticationPresent requires vendor, key and organisation together', () => {
  assert.throws(
    () =>
      ensureAuthenticationPresent({
        vendor: 'v',
        key: undefined,
        organisation: 'o',
      }),
    (err) => err.errorCode === 400,
  );
  assert.doesNotThrow(() =>
    ensureAuthenticationPresent({ vendor: 'v', key: 'k', organisation: 'o' }),
  );
});
