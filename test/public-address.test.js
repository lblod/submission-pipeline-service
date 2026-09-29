import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isInternalAddress, assertPublicUrl } from '../lib/public-address.js';
import { loadPublicJsonLd } from '../lib/context-loader.js';
import { downloadToTempFile } from '../lib/file-download.js';

let server;
let port;

before(async () => {
  server = http.createServer((req, res) => res.end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => server.close());

test('isInternalAddress flags internal ranges', () => {
  for (const address of [
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.20.0.5',
    '192.168.1.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isInternalAddress(address), true, address);
  }
});

test('isInternalAddress allows public addresses', () => {
  for (const address of ['8.8.8.8', '193.191.0.1', '2001:4860:4860::8888']) {
    assert.equal(isInternalAddress(address), false, address);
  }
});

test('assertPublicUrl rejects other protocols and internal IP literals', () => {
  for (const url of [
    'file:///etc/passwd',
    'data:text/html,hi',
    'ftp://example.com/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    assert.throws(() => assertPublicUrl(url), { permanent: true }, url);
  }
  assert.doesNotThrow(() => assertPublicUrl('https://example.com/besluit'));
});

test('context loader refuses host names that resolve internally', async () => {
  await assert.rejects(loadPublicJsonLd(`http://localhost:${port}/context`), {
    permanent: true,
  });
});

test('download refuses host names that resolve internally', async () => {
  await assert.rejects(
    downloadToTempFile({ url: `http://localhost:${port}/publication` }),
    { permanent: true },
  );
});

test('download refuses internal IP literals', async () => {
  await assert.rejects(
    downloadToTempFile({ url: `http://127.0.0.1:${port}/publication` }),
    { permanent: true },
  );
});
