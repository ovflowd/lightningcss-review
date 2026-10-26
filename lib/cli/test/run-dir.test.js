import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { captureOutput, tempDir, withEnv } from '../../../test/helpers/index.js';
import { resolveRun } from '../run-dir.js';

test('a run id is joined to runs/ as pathlib joins, since run commands print the result', () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const runs = join(dir.path, 'runs');
  const run = join(runs, 'pr7-haaaa-b1');

  mkdirSync(run, { recursive: true });
  assert.equal(resolveRun('pr7-haaaa-b1/'), run);
  assert.equal(resolveRun('./pr7-haaaa-b1'), run);
  assert.equal(resolveRun('../runs/pr7-haaaa-b1'), `${runs}/../runs/pr7-haaaa-b1`);
  // An absolute path names the run directory itself.
  assert.equal(resolveRun(run), run);
  assert.throws(() => resolveRun('-1'), { name: 'LcrError', message: 'unknown run -1' });
});

test('any digits Python calls digits select a PR, superscripts included', () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const superscriptTwo = String.fromCodePoint(0xb2);

  mkdirSync(join(dir.path, 'runs'));
  assert.throws(() => resolveRun(superscriptTwo), {
    message: `no run for PR #${superscriptTwo}; run \`lcr prepare ${superscriptTwo}\``,
  });
});

test('LATEST is stripped of whitespace as Python strips it', async () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const run = join(dir.path, 'runs', 'pr7-haaaa-b1');
  // U+001C is whitespace to Python's str.strip(), not to String.prototype.trim().
  const separator = String.fromCodePoint(0x1c);

  mkdirSync(run, { recursive: true });
  writeFileSync(join(dir.path, 'runs', 'LATEST'), `pr7-haaaa-b1${separator}\n`);

  const latest = await captureOutput(() => resolveRun('latest'));

  assert.equal(latest.result, run);
  assert.equal(latest.stderr, '[lcr] latest -> pr7-haaaa-b1\n');
});
