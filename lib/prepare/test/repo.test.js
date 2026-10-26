import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, withEnv } from '../../../test/helpers/index.js';
import { exportTree, resolveRange, revParse, runIdOf } from '../repo.js';

/**
 * A repository holding one tree object (no commit, so nothing needs signing).
 *
 * @param {string} root
 * @returns {string} The tree id.
 */
function repoWithTree(root) {
  const git = (/** @type {string[]} */ args, /** @type {string} */ input = '') =>
    execFileSync('git', ['-C', root, ...args], { input, encoding: 'utf8' }).trim();

  git(['init', '--quiet']);

  const blob = git(['hash-object', '-w', '--stdin'], 'fn main() {}\n');
  const src = git(['mktree'], `100644 blob ${blob}\tlib.rs\n`);

  return git(['mktree'], `040000 tree ${src}\tsrc\n100755 blob ${blob}\trun.sh\n`);
}

test('exportTree extracts a tree once, with modes, and leaves no archive behind', async () => {
  using dir = tempDir();
  const repo = join(dir.path, 'repo');
  const dest = join(dir.path, 'run', 'src', 'head');

  mkdirSync(repo, { recursive: true });

  const tree = repoWithTree(repo);

  using _env = withEnv({ LCR_REPO: repo });

  assert.equal(await revParse(tree), tree);
  await exportTree(tree, dest);

  assert.equal(readFileSync(join(dest, 'src', 'lib.rs'), 'utf8'), 'fn main() {}\n');
  assert.equal(statSync(join(dest, 'run.sh')).mode & 0o111, 0o111);
  assert.throws(() => statSync(`${dest}.tar`));

  // An existing export is kept as it is.
  await exportTree('does-not-exist', dest);
});

test('a failed export leaves nothing behind, so the next prepare exports again', async () => {
  using dir = tempDir();
  const repo = join(dir.path, 'repo');
  const dest = join(dir.path, 'run', 'src', 'base');

  mkdirSync(repo, { recursive: true });
  repoWithTree(repo);

  using _env = withEnv({ LCR_REPO: repo });

  await assert.rejects(exportTree('does-not-exist', dest), { name: 'LcrError' });
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.partial`), false);
  assert.equal(existsSync(`${dest}.tar`), false);
});

test('a range needs two dots', async () => {
  await assert.rejects(resolveRange('main'), { message: '--range must look like <base>..<head>' });
});

test('run ids name the PR or the range and both commits', () => {
  const resolved = /** @type {const} */ ({
    base: 'bcbeaf83b76b2113',
    prHead: '058d1ec5aaaa',
    headTree: 't',
    strategy: 'local-range',
    conflicts: [],
  });

  assert.equal(runIdOf(1385, { ...resolved, conflicts: [] }), 'pr1385-h058d1ec5-bbcbeaf83');
  assert.equal(runIdOf(null, { ...resolved, conflicts: [] }), 'range-h058d1ec5-bbcbeaf83');
});
