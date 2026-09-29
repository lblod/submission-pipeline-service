// ALLOWED_INTERNAL_ADDRESSES is read at startup, so it is set before the modules load.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';

process.env.ALLOWED_INTERNAL_ADDRESSES = '127.0.0.0/8, ::1';
process.env.FILE_STORAGE = tmpdir();
const { isInternalAddress } = await import('../lib/public-address.js');
const { downloadToTempFile } = await import('../lib/file-download.js');

let server;
let port;

before(async () => {
  server = http.createServer((req, res) =>
    res.end('<html><body>test</body></html>'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => server.close());

test('allowed ranges are no longer internal, others still are', () => {
  assert.equal(isInternalAddress('127.0.0.1'), false);
  assert.equal(isInternalAddress('::1'), false);
  assert.equal(isInternalAddress('10.0.0.1'), true);
  assert.equal(isInternalAddress('169.254.169.254'), true);
});

test('download from an allowed address succeeds', async () => {
  const result = await downloadToTempFile({
    url: `http://127.0.0.1:${port}/publication`,
  });
  assert.equal(result.httpStatusCode, 200);
});
