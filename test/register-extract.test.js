import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataFactory, Store } from 'n3';
import {
  extractMeldingUri,
  findSubmittedResource,
  extractLocationUrl,
  extractInfoForRegister,
  extractAuthentication,
  storeToTurtle,
} from '../lib/register-extract.js';

const { namedNode, quad, literal } = DataFactory;
const n = namedNode;

function buildStore() {
  const store = new Store();
  const submission = n('http://data.lblod.info/submissions/1');
  const submittedResource = n('http://example.org/besluit/1');
  const vendor = n('http://data.lblod.info/vendors/acme');

  store.addQuads([
    quad(
      submission,
      n('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      n('http://rdf.myexperiment.org/ontologies/base/Submission'),
    ),
    quad(submission, n('http://purl.org/dc/terms/subject'), submittedResource),
    quad(
      submission,
      n('http://www.w3.org/ns/prov#atLocation'),
      n('http://example.org/publication.html'),
    ),
    quad(
      submission,
      n('http://www.w3.org/ns/adms#status'),
      n('http://lblod.data.gift/concepts/79a52da4-f491-4e2f-9374-89a13cde8ecd'),
    ),
    quad(submission, n('http://purl.org/pav/providedBy'), vendor),
    quad(
      submission,
      n('http://purl.org/pav/createdBy'),
      n('http://data.lblod.info/id/bestuurseenheden/1'),
    ),
    quad(
      vendor,
      n('http://mu.semte.ch/vocabularies/account/key'),
      n('http://example.org/does-not-matter'),
    ),
    // vendor node itself carries a triple that must be stripped from the persisted turtle
    quad(vendor, n('http://xmlns.com/foaf/0.1/name'), literal('Acme')),
  ]);
  return { store, submission, submittedResource, vendor };
}

test('extractMeldingUri finds the meb:Submission subject', () => {
  const { store, submission } = buildStore();
  assert.equal(extractMeldingUri(store), submission.value);
});

test('findSubmittedResource finds dct:subject', () => {
  const { store, submittedResource } = buildStore();
  assert.equal(findSubmittedResource(store), submittedResource.value);
});

test('extractLocationUrl finds prov:atLocation', () => {
  const { store } = buildStore();
  assert.equal(
    extractLocationUrl(store),
    'http://example.org/publication.html',
  );
});

test('extractInfoForRegister gathers the four register-time properties', () => {
  const { store } = buildStore();
  const info = extractInfoForRegister(store);
  assert.equal(info.href, 'http://example.org/publication.html');
  assert.equal(info.submittedResource, 'http://example.org/besluit/1');
  assert.equal(
    info.status,
    'http://lblod.data.gift/concepts/79a52da4-f491-4e2f-9374-89a13cde8ecd',
  );
  assert.equal(info.authenticationConfiguration, undefined);
});

test('extractAuthentication finds vendor, key and organisation', () => {
  const { store } = buildStore();
  const auth = extractAuthentication(store);
  assert.equal(auth.vendor, 'http://data.lblod.info/vendors/acme');
  assert.equal(
    auth.organisation,
    'http://data.lblod.info/id/bestuurseenheden/1',
  );
  // extractAuthentication takes the first muAccount:key in the body
  assert.equal(auth.key, 'http://example.org/does-not-matter');
});

test('storeToTurtle strips every triple about the vendor node, keeps the rest', async () => {
  const { store } = buildStore();
  const ttl = await storeToTurtle(store);
  assert.doesNotMatch(ttl, /Acme/);
  assert.doesNotMatch(ttl, /does-not-matter/);
  assert.match(ttl, /besluit\/1/);
  assert.match(ttl, /publication\.html/);
});
