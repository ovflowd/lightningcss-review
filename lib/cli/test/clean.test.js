import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { clean, cleanRun } from '../clean.js';

test('cleanRun drops build trees and raw results only once later stages are safe', () => {
  using dir = tempDir();
  const run = dir.path;

  writeFiles(run, {
    'build/head/tree/f': 'x'.repeat(10),
    'oracle/results-latest.jsonl': 'y'.repeat(5),
  });
  mkdirSync(join(run, 'oracle', 'shots'));
  // No build.json and no verdicts.jsonl yet: nothing may go.
  assert.equal(cleanRun(run, { buildTrees: true, results: true }), 0);

  writeFiles(run, { 'build.json': '{}', 'oracle/verdicts.jsonl': '' });
  assert.equal(cleanRun(run, { buildTrees: true, results: true }), 15);
  assert.equal(existsSync(join(run, 'build', 'head', 'tree')), false);
  assert.equal(existsSync(join(run, 'oracle', 'shots')), false);
  assert.equal(existsSync(join(run, 'oracle', 'verdicts.jsonl')), true);
});

test('results are dropped next to every verdicts.jsonl, nested ones included', () => {
  using dir = tempDir();

  writeFiles(dir.path, {
    'oracle/rerun/verdicts.jsonl': '',
    'oracle/rerun/results-legacy-2021.jsonl': 'abc',
    'oracle/rerun/shots/a.png': 'pngpng',
    'oracle/results-latest.jsonl': 'zz',
  });
  // Top-level oracle/ has no verdicts.jsonl, so its results stay.
  assert.equal(cleanRun(dir.path, { buildTrees: false, results: true }), 9);
  assert.equal(existsSync(join(dir.path, 'oracle', 'results-latest.jsonl')), true);
});

test('clean keeps the newest runs, or cleans one run, and logs what it freed', async (t) => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const runs = join(dir.path, 'runs');
  const stderr = t.mock.method(process.stderr, 'write', () => true);

  for (const [name, age] of /** @type {const} */ ([
    ['pr1-ha-b', 30],
    ['pr2-ha-b', 20],
    ['pr3-ha-b', 10],
  ])) {
    writeFiles(join(runs, name), { 'build.json': '{}', 'build/base/tree/x': 'x'.repeat(2048) });
    utimesSync(join(runs, name), new Date(Date.now() - age * 1000), new Date(Date.now() - age * 1000));
  }

  writeFileSync(join(runs, 'LATEST'), 'pr3-ha-b\n');

  assert.equal(await clean({ run: 'pr3-ha-b' }), 0);
  assert.equal(existsSync(join(runs, 'pr3-ha-b', 'build', 'base', 'tree')), false);
  assert.equal(await clean({ results: true }), 0);
  assert.equal(await clean({ keep: 2 }), 0);
  stderr.mock.restore();

  assert.deepEqual(
    stderr.mock.calls.map((call) => call.arguments[0]),
    ['[lcr] freed 0 MiB in 1 run(s)\n', '[lcr] freed 0 MiB in 3 run(s)\n', '[lcr] removed pr1-ha-b\n'],
  );
  assert.equal(existsSync(join(runs, 'pr1-ha-b')), false);
  assert.equal(existsSync(join(runs, 'pr2-ha-b')), true);
  assert.equal(existsSync(join(runs, 'LATEST')), true);
});

test('an empty run argument never deletes runs, however many there are', async (t) => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const stderr = t.mock.method(process.stderr, 'write', () => true);

  for (const name of ['pr1-ha-b', 'pr2-ha-b', 'pr3-ha-b']) {
    mkdirSync(join(dir.path, 'runs', name), { recursive: true });
  }

  // `lcr clean ''`: an empty run name visits every run (dropping nothing) instead of keeping the
  // newest.
  assert.equal(await clean({ run: '', keep: 1 }), 0);
  stderr.mock.restore();

  assert.deepEqual(
    stderr.mock.calls.map((call) => call.arguments[0]),
    ['[lcr] freed 0 MiB in 3 run(s)\n'],
  );
  assert.equal(existsSync(join(dir.path, 'runs', 'pr1-ha-b')), true);
});
