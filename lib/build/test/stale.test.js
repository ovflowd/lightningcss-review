import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { cliOutput, smokeInputs, smokeOutputs, staleReason } from '../stale.js';

const bytes = (/** @type {string} */ text) => Buffer.from(text);

test('identical release binaries are stale when the diff changes src/', () => {
  assert.match(
    /** @type {string} */ (
      staleReason({ base: bytes('bin'), head: bytes('bin'), files: ['src/lib.rs', 'README.md'], smoke: [] })
    ),
    /byte-identical/,
  );
  assert.equal(
    staleReason({ base: bytes('bin'), head: bytes('bin'), files: ['README.md'], smoke: [] }),
    null,
  );
  assert.equal(
    staleReason({ base: bytes('bin'), head: bytes('bin2'), files: ['src/lib.rs'], smoke: [] }),
    null,
  );
});

test('release binaries that print the base output where the adapters differ are stale', () => {
  const evidence = { base: bytes('a'), head: bytes('b'), files: ['src/lib.rs'] };
  const same = /** @type {[string, string][]} */ ([
    ['x', 'x'],
    ['y', 'y'],
  ]);

  assert.match(
    /** @type {string} */ (staleReason({ ...evidence, smoke: same })),
    /same output on 2 delta case\(s\)/,
  );
  assert.equal(staleReason({ ...evidence, smoke: [same[0], ['y', 'z']] }), null);
});

/**
 * An executable shell script.
 *
 * @param {string} path
 * @param {string} body
 * @returns {string}
 */
function script(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);

  return path;
}

test('smoke inputs are the plain minify deltas, by id; outputs stop at the first difference', async () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: join(dir.path, 'cache') });
  const sheet = (/** @type {string} */ css, extra = {}) => ({
    kind: 'sheet',
    css,
    minify: true,
    compact: true,
    targets: null,
    ...extra,
  });
  const ok = (/** @type {string} */ code) => ({ ok: true, code });

  writeFiles(dir.path, {
    'corpus/cases.jsonl': [
      { id: 'd', request: sheet('.d{}') },
      { id: 'a', request: sheet('.a{}') },
      { id: 'b', request: sheet('.b{}', { targets: { chrome: 1 } }) },
      { id: 'c', request: sheet('.c{}') },
      { id: 'e', request: { ...sheet('.e{}'), compact: false } },
      { id: 'f', request: sheet('.f{}', { flags: [], filename: 'x.css', error_recovery: 0 }) },
    ],
    'corpus/deltas.jsonl': [
      { id: 'a', base: ok('1'), head: ok('2') },
      { id: 'b', base: ok('1'), head: ok('2') },
      { id: 'c', base: { ok: false }, head: ok('2') },
      { id: 'd', base: ok('1'), head: ok('2') },
      { id: 'e', base: ok('1'), head: ok('2') },
      { id: 'f', base: ok('1'), head: { ok: true } },
    ],
  });

  assert.deepEqual(smokeInputs(dir.path), ['.a{}', '.d{}', '.f{}']);
  assert.deepEqual(smokeInputs(dir.path, { limit: 1 }), ['.a{}']);

  const binaries = {
    base: script(join(dir.path, 'base'), 'echo B'),
    head: script(join(dir.path, 'head'), 'if grep -q d "$2"; then echo H; else echo B; fi'),
  };

  assert.deepEqual(await smokeOutputs(binaries, ['.a{}', '.d{}', '.x{}']), [
    ['B\n', 'B\n'],
    ['B\n', 'H\n'],
  ]);
});

test('cliOutput is null when the CLI fails', () => {
  using dir = tempDir();

  assert.equal(cliOutput(script(join(dir.path, 'bad'), 'exit 3'), 'x.css'), null);
  assert.equal(cliOutput(script(join(dir.path, 'crlf'), "printf 'a\\r\\n'"), 'x.css'), 'a\n');
});
