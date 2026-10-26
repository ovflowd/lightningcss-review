import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT, captureOutput, tempDir, withEnv } from '../../../test/helpers/index.js';
import { run } from '../../core/proc.js';
import { resolveRun } from '../run-dir.js';

const LCR = join(REPO_ROOT, 'bin', 'lcr');

/**
 * Run bin/lcr.
 *
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<import('../../core/proc.js').RunResult>}
 */
function lcr(args, env = {}) {
  return run([LCR, ...args], { check: false, env });
}

test('usage errors exit 2 with argparse-style messages', async () => {
  const missing = await lcr([]);

  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /lcr: error: the following arguments are required: command/);

  const badInt = await lcr(['review', 'abc']);

  assert.equal(badInt.code, 2);
  assert.match(badInt.stderr, /lcr review: error: argument pr: invalid int value: 'abc'/);

  const badChoice = await lcr(['corpus', 'x', '--wpt', 'some']);

  assert.equal(badChoice.code, 2);
  assert.match(badChoice.stderr, /invalid choice: 'some'/);
  assert.equal((await lcr(['frobnicate'])).code, 2);
  assert.equal((await lcr(['show', 'run-only'])).code, 2);
});

test('help exits 0 and lists every command', async () => {
  const help = await lcr(['--help']);

  assert.equal(help.code, 0);

  for (const name of ['doctor', 'prepare', 'oracle', 'report', 'validate-probes', 'spec-coverage']) {
    assert.match(help.stdout, new RegExp(`\\b${name}\\b`));
  }

  assert.match((await lcr(['table', '--help'])).stdout, /--transition/);
});

test('an LcrError from argument resolution or from a stage exits 2 with [lcr] error:', async () => {
  using dir = tempDir();
  const result = await lcr(['status', 'nope'], { LCR_CACHE: dir.path });

  assert.equal(result.code, 2);
  assert.equal(result.stderr, '[lcr] error: unknown run nope\n');

  mkdirSync(join(dir.path, 'runs', 'pr1-ha-bb'), { recursive: true });

  // An empty run: the stage fails with an LcrError naming the missing stage and its command,
  // never with a stack trace.
  const stage = await lcr(['report', '1'], { LCR_CACHE: dir.path });

  assert.equal(stage.code, 2);
  assert.equal(stage.stderr, '[lcr] error: no prepare.json; run `lcr prepare`\n');
});

test('resolveRun takes an id, a PR number (newest run) or latest, never nothing', async () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const runs = join(dir.path, 'runs');

  assert.throws(() => resolveRun(null), /pass a run id/);
  assert.throws(() => resolveRun('latest'), /no runs yet/);
  assert.throws(() => resolveRun('7'), /no run for PR #7/);

  for (const [name, ageSeconds] of /** @type {const} */ ([
    ['pr7-haaaa-b1', 20],
    ['pr7-hbbbb-b1', 10],
  ])) {
    const when = new Date(Date.now() - ageSeconds * 1000);

    mkdirSync(join(runs, name), { recursive: true });
    utimesSync(join(runs, name), when, when);
  }

  writeFileSync(join(runs, 'LATEST'), 'pr7-haaaa-b1\n');

  const byPr = await captureOutput(() => resolveRun('7'));

  assert.equal(byPr.result, join(runs, 'pr7-hbbbb-b1'));
  assert.equal(byPr.stderr, '[lcr] PR #7 -> pr7-hbbbb-b1 (newest of 2 runs)\n');
  assert.equal((await captureOutput(() => resolveRun('latest'))).result, join(runs, 'pr7-haaaa-b1'));
  assert.equal(resolveRun('pr7-haaaa-b1'), join(runs, 'pr7-haaaa-b1'));
});

test('long options take unambiguous prefixes and negative numbers, as argparse does', async () => {
  using dir = tempDir();

  mkdirSync(join(dir.path, 'runs'));

  const results = await lcr(['clean', '--res'], { LCR_CACHE: dir.path });

  assert.equal(results.code, 0, results.stderr);
  assert.equal(results.stderr, '[lcr] freed 0 MiB in 0 run(s)\n');
  assert.equal((await lcr(['clean', '--kee', '-1'], { LCR_CACHE: dir.path })).code, 0);
  assert.equal((await lcr(['clean', '--keep=-1'], { LCR_CACHE: dir.path })).code, 0);

  const ambiguous = await lcr(['table', 'x', '--c', 'O1']);

  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.stderr, /lcr table: error: ambiguous option: --c could match --check, --case/);
});
