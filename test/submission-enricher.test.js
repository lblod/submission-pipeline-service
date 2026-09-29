import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCentraalBestuurVanEredienstDocument,
  calculateAttachmentsToDownload,
} from '../lib/submission-enricher.js';

const DOC = 'http://example.org/decisions/1';
const CBE_TYPE =
  'https://data.vlaanderen.be/id/concept/BesluitDocumentType/18833df2-8c9e-4edd-87fd-b5c252337349';

function triple(subject, predicate, object) {
  return { subject, predicate, object };
}

test('isCentraalBestuurVanEredienstDocument: true when the document has a matching type via "a"', () => {
  const triples = [triple(DOC, 'a', CBE_TYPE)];
  assert.equal(isCentraalBestuurVanEredienstDocument(DOC, triples), true);
});

test('isCentraalBestuurVanEredienstDocument: true via the full rdf:type predicate too', () => {
  const triples = [
    triple(DOC, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', CBE_TYPE),
  ];
  assert.equal(isCentraalBestuurVanEredienstDocument(DOC, triples), true);
});

test('isCentraalBestuurVanEredienstDocument: false for an unrelated type or document', () => {
  assert.equal(
    isCentraalBestuurVanEredienstDocument(DOC, [
      triple(DOC, 'a', 'http://example.org/OtherType'),
    ]),
    false,
  );
  assert.equal(
    isCentraalBestuurVanEredienstDocument(DOC, [
      triple('http://example.org/other', 'a', CBE_TYPE),
    ]),
    false,
  );
});

test('calculateAttachmentsToDownload: simple dct:source on the document', () => {
  const triples = [
    triple(
      DOC,
      'http://purl.org/dc/terms/source',
      'http://example.org/attachment.pdf',
    ),
  ];
  assert.deepEqual(calculateAttachmentsToDownload(DOC, triples), [
    'http://example.org/attachment.pdf',
  ]);
});

test('calculateAttachmentsToDownload: eli:related_to on the document', () => {
  const triples = [
    triple(
      DOC,
      'http://data.europa.eu/eli/ontology#related_to',
      'http://example.org/related.pdf',
    ),
  ];
  assert.deepEqual(calculateAttachmentsToDownload(DOC, triples), [
    'http://example.org/related.pdf',
  ]);
});

test('calculateAttachmentsToDownload: CBE document follows dct:relation then dct:source', () => {
  const related = 'http://example.org/related-document';
  const triples = [
    triple(DOC, 'a', CBE_TYPE),
    triple(DOC, 'http://purl.org/dc/terms/relation', related),
    triple(
      related,
      'http://purl.org/dc/terms/source',
      'http://example.org/cbe-attachment.pdf',
    ),
  ];
  assert.deepEqual(calculateAttachmentsToDownload(DOC, triples), [
    'http://example.org/cbe-attachment.pdf',
  ]);
});

test('calculateAttachmentsToDownload: non-CBE document ignores dct:relation entirely', () => {
  const related = 'http://example.org/related-document';
  const triples = [
    // no CBE type triple this time
    triple(DOC, 'http://purl.org/dc/terms/relation', related),
    triple(
      related,
      'http://purl.org/dc/terms/source',
      'http://example.org/should-not-appear.pdf',
    ),
  ];
  assert.deepEqual(calculateAttachmentsToDownload(DOC, triples), []);
});

test('calculateAttachmentsToDownload: all three sources combine, duplicates not removed', () => {
  const related = 'http://example.org/related-document';
  const triples = [
    triple(DOC, 'a', CBE_TYPE),
    triple(DOC, 'http://purl.org/dc/terms/relation', related),
    triple(
      related,
      'http://purl.org/dc/terms/source',
      'http://example.org/a.pdf',
    ),
    triple(DOC, 'http://purl.org/dc/terms/source', 'http://example.org/a.pdf'),
    triple(
      DOC,
      'http://data.europa.eu/eli/ontology#related_to',
      'http://example.org/b.pdf',
    ),
  ];
  assert.deepEqual(calculateAttachmentsToDownload(DOC, triples), [
    'http://example.org/a.pdf',
    'http://example.org/a.pdf',
    'http://example.org/b.pdf',
  ]);
});
