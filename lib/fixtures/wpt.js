/**
 * The WPT property corpus: a pinned, sparse checkout of web-platform-tests (css/, resources/,
 * common/) and the parsing cases extracted from it by the extractor vendored from Lightning CSS
 * (oracle/wpt/extract.mjs, run in the analysis image).
 *
 * Stage: `lcr wpt` builds `<cache>/wpt/fixtures-<commit12>.json` once; corpus (the WPT lane)
 * reads it with `loadFixtures` and picks the property directories of the PR's areas with
 * `wptPropertyDirs`.
 *
 * Invariant: the revision is config/wpt.json's commit, so the fixtures (and every WPT case id
 * derived from them) only change when the pin changes.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { requireDocker } from '../core/docker.js';
import { LcrError } from '../core/errors.js';
import { readJson } from '../core/files.js';
import { log } from '../core/log.js';
import { cacheDir, loadConfig, SKILL_DIR } from '../core/paths.js';
import { run } from '../core/proc.js';
import { pyStrip, pySplitlines } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';
import { ensureBrowsers, runBrowsers } from '../setup/images.js';

/** @import { AreasConfig } from '../types.js' */

/** The fixtures file name carries this many characters of the commit. */
const SHORT_COMMIT_CHARS = 12;
/** Cloning and checking out WPT moves a few hundred MB. */
const GIT_TIMEOUT_MS = 30 * 60_000;
const SPARSE_TIMEOUT_MS = 60 * 60_000;
const EXTRACT_TIMEOUT_MS = 60 * 60_000;
/** A failed extraction shows this much of its output. */
const ERROR_TAIL_CHARS = 3000;
/** The directories of WPT the extractor reads. */
const SPARSE_DIRS = ['css', 'resources', 'common'];

/**
 * @typedef {object} WptRevision config/wpt.json
 * @property {string} repository
 * @property {string} commit
 */

/**
 * @typedef {object} WptFixture One extracted case.
 * @property {string} id
 * @property {string} file
 * @property {string} kind
 * @property {string} property
 * @property {string} value
 * @property {unknown} [expected]
 */

/**
 * The fixtures file of the pinned revision.
 *
 * @param {WptRevision} revision
 * @returns {string}
 */
function fixturesPath(revision) {
  return join(cacheDir(), 'wpt', `fixtures-${revision.commit.slice(0, SHORT_COMMIT_CHARS)}.json`);
}

/**
 * The sparse checkout at the pinned commit, cloned on first use and moved when the pin changes.
 *
 * @param {WptRevision} revision
 * @returns {Promise<string>}
 */
async function checkout(revision) {
  const path = join(cacheDir(), 'wpt', 'checkout');
  /**
   * `git -C <checkout> …`, with time for a large fetch.
   *
   * @param {string[]} args
   * @param {number} [timeoutMs]
   * @returns {Promise<import('../core/proc.js').RunResult>}
   */
  const git = (args, timeoutMs = GIT_TIMEOUT_MS) => run(['git', '-C', path, ...args], { timeoutMs });

  if (existsSync(join(path, '.git'))) {
    const head = await run(['git', '-C', path, 'rev-parse', 'HEAD'], { check: false });

    if (pyStrip(head.stdout) !== revision.commit) {
      await git(['fetch', '--quiet', '--depth', '1', 'origin', revision.commit]);
      await git(['checkout', '--quiet', '--detach', revision.commit]);
    }

    return path;
  }

  mkdirSync(dirname(path), { recursive: true });
  log(
    `cloning WPT (sparse: css, resources) at ${revision.commit.slice(0, SHORT_COMMIT_CHARS)}; one-time, a few hundred MB`,
  );
  await run(
    ['git', 'clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', revision.repository, path],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  await git(['fetch', '--quiet', '--depth', '1', 'origin', revision.commit]);
  await git(['checkout', '--quiet', '--detach', revision.commit]);
  await git(['sparse-checkout', 'set', ...SPARSE_DIRS], SPARSE_TIMEOUT_MS);

  return path;
}

/**
 * Check out the pinned revision and extract the fixtures, unless they exist already (or
 * `refresh`); resolves to the fixtures file.
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function ensureFixtures({ refresh = false } = {}) {
  const revision = /** @type {WptRevision} */ (loadConfig('wpt.json'));
  const fixtures = fixturesPath(revision);
  const outDir = dirname(fixtures);

  if (existsSync(fixtures) && !refresh) {
    return fixtures;
  }

  requireDocker();

  const root = await checkout(revision);

  await ensureBrowsers('latest');

  const result = await runBrowsers(
    'latest',
    [
      'node',
      '/opt/lcr/oracle/wpt/extract.mjs',
      '/wpt',
      '--discovery',
      '--output',
      `/out/${basename(fixtures)}`,
    ],
    {
      mounts: [
        { host: join(SKILL_DIR, 'oracle'), container: '/opt/lcr/oracle', mode: 'ro' },
        { host: root, container: '/wpt', mode: 'rw' },
        { host: outDir, container: '/out', mode: 'rw' },
      ],
      // The checkout is owned by the host user, not the container's; git refuses it otherwise.
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' },
      check: false,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    },
  );

  if (result.code !== 0 || !existsSync(fixtures)) {
    const output = `${result.stdout}${result.stderr}`;

    throw new LcrError(`WPT extraction failed:\n${Array.from(output).slice(-ERROR_TAIL_CHARS).join('')}`);
  }

  const stdout = pyStrip(result.stdout);

  log(stdout ? /** @type {string} */ (pySplitlines(stdout).at(-1)) : 'extracted');

  return fixtures;
}

/**
 * The extracted fixtures of the pinned revision, or null before `lcr wpt` ran.
 *
 * @returns {{ cases: WptFixture[] } | null}
 */
export function loadFixtures() {
  const revision = /** @type {WptRevision} */ (loadConfig('wpt.json'));

  return /** @type {{ cases: WptFixture[] } | null} */ (readJson(fixturesPath(revision)));
}

/**
 * The WPT property directories that belong to these areas (config/areas.json), sorted, unique.
 *
 * @param {readonly string[]} areas
 * @returns {string[]}
 */
export function wptPropertyDirs(areas) {
  const meta = /** @type {AreasConfig} */ (loadConfig('areas.json')).areas;
  const dirs = new Set(areas.flatMap((area) => (Object.hasOwn(meta, area) ? (meta[area].wpt ?? []) : [])));

  return [...dirs].sort(compareCodePoints);
}
