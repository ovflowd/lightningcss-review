import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { captureOutput, FIXTURES_DIR, tempDir, withEnv } from '../../../test/helpers/index.js';
import { repoDir, skillVersion } from '../../core/paths.js';
import { prepare } from '../prepare.js';

const FIXTURE = join(FIXTURES_DIR, 'build', 'prepare-range');

/**
 * A clone stand-in holding the fixture's base/ and head/ directories as two tree objects (staged
 * with `git add` into separate index files and written with `write-tree`: no commit is created),
 * with `refs/lcr/master` on the base tree.
 *
 * @param {string} repo
 * @returns {string} The head tree id.
 */
function repoWithTrees(repo) {
  const git = (/** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  const treeOf = (/** @type {string} */ side) => {
    const env = { GIT_INDEX_FILE: join(repo, `.git/index-${side}`) };

    git([`--work-tree=${join(FIXTURE, side)}`, 'add', '-A'], env);

    return git(['write-tree'], env);
  };

  execFileSync('git', ['init', '--quiet', repo]);
  git(['remote', 'add', 'origin', 'https://github.com/parcel-bundler/lightningcss.git']);
  git(['update-ref', 'refs/lcr/master', treeOf('base')]);

  return treeOf('head');
}

/**
 * Every file under `root`, relative and sorted (as `find . -type f | sort` lists them).
 *
 * @param {string} root
 * @returns {string[]}
 */
function filesUnder(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `./${relative(root, join(entry.parentPath, entry.name))}`)
    .sort();
}

test('prepare --range writes the expected run directory for two fixed trees', async () => {
  using dir = tempDir();
  const cache = join(dir.path, 'cache');

  using _env = withEnv({ LCR_REPO: join(dir.path, 'repo'), LCR_CACHE: cache });
  const head = repoWithTrees(repoDir());
  const expected = (/** @type {string} */ name) => readFileSync(join(FIXTURE, 'expected', name), 'utf8');
  const runId = expected('LATEST').trim();
  const { result: runDir, stderr } = await captureOutput(() =>
    prepare({ localRange: `refs/lcr/master..${head}`, offline: true }),
  );

  assert.equal(runDir, join(cache, 'runs', runId));
  assert.match(stderr, /\(local-range\)/);
  assert.equal(readFileSync(join(runDir, 'diff.patch'), 'utf8'), expected('diff.patch'));
  assert.equal(
    readFileSync(join(runDir, 'prepare.json'), 'utf8'),
    expected('prepare.json')
      .replaceAll('<REPO>', repoDir())
      .replaceAll('<CACHE>', cache)
      .replace('<SKILL_VERSION>', skillVersion()),
  );
  assert.equal(readFileSync(join(cache, 'runs', 'LATEST'), 'utf8'), `${runId}\n`);
  assert.deepEqual(filesUnder(join(runDir, 'src')), expected('trees.txt').trim().split('\n'));
});

test('prepare needs a PR number or a range', async () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_REPO: join(dir.path, 'repo'), LCR_CACHE: join(dir.path, 'cache') });

  repoWithTrees(repoDir());
  await assert.rejects(prepare({ offline: true }), { message: 'pass a PR number or --range base..head' });
});
