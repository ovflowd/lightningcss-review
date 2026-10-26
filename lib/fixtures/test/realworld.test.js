import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, withEnv } from '../../../test/helpers/index.js';
import { loadConfig } from '../../core/paths.js';
import { availableFiles, ensureRealworld, realworldDir } from '../realworld.js';

const CONFIG = /** @type {import('../realworld.js').RealworldConfig} */ (loadConfig('realworld.json'));

test('availableFiles lists only files whose bytes match their pin', (t) => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const stderr = t.mock.method(process.stderr, 'write', () => true);

  assert.deepEqual(availableFiles(), []);
  assert.equal(
    stderr.mock.calls[0].arguments[0],
    '[lcr] real-world corpus not downloaded; run `lcr realworld` once\n',
  );

  // A file with the right name but other bytes does not count.
  writeFileSync(join(realworldDir(), `${CONFIG.files[0].name}.css`), 'a{}');
  assert.deepEqual(availableFiles(), []);
  stderr.mock.restore();
});

test('a download whose hash differs from the pin is refused and not written', async (t) => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const first = CONFIG.files[0];

  t.mock.method(process.stderr, 'write', () => true);
  t.mock.method(globalThis, 'fetch', async () => new Response('changed upstream'));

  await assert.rejects(ensureRealworld(), {
    name: 'LcrError',
    message: new RegExp(
      `^${first.name}: sha256 mismatch \\(pinned ${first.sha256?.slice(0, 12)}, got [0-9a-f]{12}\\); the upstream file changed$`,
    ),
  });
  assert.throws(() => readFileSync(join(realworldDir(), `${first.name}.css`)), { code: 'ENOENT' });
});

test('an HTTP error is an LcrError', async (t) => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });

  t.mock.method(process.stderr, 'write', () => true);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404, statusText: 'Not Found' }));

  await assert.rejects(ensureRealworld(), {
    name: 'LcrError',
    message: /HTTP 404 Not Found; check the network, or the URL in config\/realworld.json$/,
  });
});
