/**
 * The JS lane: CI's test-js job (`yarn build`, `yarn test`, `yarn tsc`) and generated-file drift
 * (src/compat.rs and friends from `build-prefixes.js`, node/ast.d.ts from `yarn build-ast`),
 * inside the builder image on one side's instrumented tree.
 *
 * Stage: build (build.json `js`). Writes build/<side>/js.log and js.failed.
 *
 * Invariants:
 * - Generated files can already drift on master, so drift is recorded as a position-independent
 *   signature and only a head drift that differs from base's is the PR's (`newDrift`).
 * - Two containers per side: the dependency install (`JS_INSTALL`, no lifecycle scripts) in the
 *   networked builder with only the tree, build/<side>/ and the yarn cache mounted (the cache
 *   writable there and nowhere else), then every other step in `builder-offline` with the Cargo
 *   home and the yarn cache read-only.
 * - Cargo builds into `targets/js-base` for base (shared: base is trusted) and into
 *   `targets/js-head` for head, which is reset to a copy of `js-base` on every run
 *   (target-dirs.js). Base runs first, so head starts from this run's base.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { unifiedDiff } from '../core/difflib.js';
import { readPyText, removeFile } from '../core/files.js';
import { sha256 } from '../core/ids.js';
import { cacheDir } from '../core/paths.js';
import { compareCodePoints, pySplitlines, pyStrip } from '../core/py.js';
import { runBuilder } from '../setup/images.js';
import { jsLaneScript, jsSteps, ROOT_LIFECYCLE } from './scripts.js';
import { failOnTimeout } from './side.js';
import { lockTarget, SEEDS, seedTargets, targetDir } from './target-dirs.js';
import { toolchainChannel } from './tree.js';

/** @import { JsLane, Side } from '../types.js' */
/** @import { Mount } from '../core/docker.js' */
/** @import { JsSteps } from './scripts.js' */

/** Files `node scripts/build-prefixes.js` regenerates. */
export const GENERATED_COMPAT = Object.freeze([
  'src/compat.rs',
  'src/prefixes.rs',
  'src/targets.rs',
  'node/targets.d.ts',
  'node/flags.js',
]);

/** yarn install, build, test and tsc on a cold cache. */
const JS_TIMEOUT_MS = 2 * 60 * 60_000;
/** The yarn cache, inside the Cargo home as earlier versions kept it (jsLaneScript's path). */
const YARN_CACHE = 'yarn-cache';
/** Where the lane script finds the yarn cache in its container. */
const CONTAINER_YARN_CACHE = `/cargo/${YARN_CACHE}`;
/** The install must not execute a `yarn-path` named by the tree's settings (belt and braces). */
const INSTALL_ENV = Object.freeze({ YARN_IGNORE_PATH: '1' });
/** Cargo must not try the network in the offline steps. */
const OFFLINE_ENV = Object.freeze({ CARGO_NET_OFFLINE: 'true' });

/**
 * Hash of the changed lines of regenerated vs committed output, without positions, so the same
 * drift on both sides compares equal even when line numbers moved.
 *
 * @param {Uint8Array} pristine
 * @param {Uint8Array} regenerated
 * @returns {string}
 */
export function driftSignature(pristine, regenerated) {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const before = pySplitlines(decoder.decode(pristine));
  const after = pySplitlines(decoder.decode(regenerated));
  const changed = [...unifiedDiff(before, after, { context: 0, lineterm: '' })].filter(
    (line) =>
      (line === '' || line.startsWith('+') || line.startsWith('-')) &&
      !line.startsWith('+++ ') &&
      !line.startsWith('--- '),
  );

  return sha256(changed.join('\n'));
}

/**
 * Generated files whose drift on head differs from base's.
 *
 * @param {Record<string, string>} head file -> drift signature
 * @param {Record<string, string>} base
 * @returns {string[]} Sorted.
 */
export function newDrift(head, base) {
  return Object.keys(head)
    .filter((file) => head[file] !== (Object.hasOwn(base, file) ? base[file] : undefined))
    .sort(compareCodePoints);
}

/**
 * Run the JS lane on one side's tree.
 *
 * @param {string} runDir
 * @param {JsSteps & { side?: Side }} options
 * @returns {Promise<JsLane & { ran: true, steps: string[], failed_step: string | null, drift: Record<string, string>, log: string }>}
 */
export async function jsLane(runDir, { runJs, regenCompat, regenAst, side = 'head' }) {
  const tree = join(runDir, 'build', side, 'tree');
  const pristine = join(runDir, 'src', side);
  const out = join(runDir, 'build', side);
  const steps = jsSteps({ runJs, regenCompat, regenAst, lifecycle: rootLifecycle(tree) });
  const cache = cacheDir();
  const failedFile = join(out, 'js.failed');

  removeFile(join(out, 'js.log'));
  removeFile(failedFile);
  mkdirSync(join(cache, 'cargo-home', YARN_CACHE), { recursive: true });

  {
    await using _lock = await jsTarget(cache, side);
    const target = targetDir(cache, side === 'base' ? 'js-base' : 'js-head');
    const lane = { channel: toolchainChannel(tree), tree, out, cache, side };

    await runSteps(lane, steps.slice(0, 1), { network: true, target });

    if (!existsSync(failedFile)) {
      await runSteps(lane, steps.slice(1), { network: false, target });
    }
  }

  const failed = existsSync(failedFile) ? pyStrip(readPyText(failedFile, { replace: true })) : null;
  const generated = [...(regenCompat ? GENERATED_COMPAT : []), ...(regenAst ? ['node/ast.d.ts'] : [])];

  return {
    ran: true,
    steps,
    failed_step: failed,
    drift: failed ? {} : drifts(generated, pristine, tree),
    log: join(out, 'js.log'),
    js_tests: runJs,
    regen_compat: regenCompat,
    regen_ast: regenAst,
  };
}

/**
 * Take the lock of a side's JS target directory; head's is reset to a copy of base's first.
 *
 * @param {string} cache
 * @param {Side} side
 * @returns {Promise<import('../core/lock.js').FileLock>}
 */
async function jsTarget(cache, side) {
  const [[base, head]] = SEEDS.js;

  if (side === 'base') {
    mkdirSync(targetDir(cache, base), { recursive: true });

    return lockTarget(cache, base);
  }

  const lock = await lockTarget(cache, head);

  try {
    await seedTargets(cache, SEEDS.js, { baseLock: base });
  } catch (error) {
    lock.release();

    throw error;
  }

  return lock;
}

/**
 * @typedef {object} LaneContext
 * @property {string} channel
 * @property {string} tree build/<side>/tree
 * @property {string} out build/<side>/
 * @property {string} cache
 * @property {Side} side
 */

/**
 * Run some of the lane's steps in one container: the install with the network and the yarn cache
 * writable (and no Cargo home: it builds nothing), the rest offline with the caches read-only.
 *
 * @param {LaneContext} lane
 * @param {string[]} steps
 * @param {{ network: boolean, target: string }} options `target` is the side's JS target.
 * @returns {Promise<void>}
 */
async function runSteps({ channel, tree, out, cache, side }, steps, { network, target }) {
  if (steps.length === 0) {
    return;
  }

  /** @type {Mount[]} */
  const caches = network
    ? [{ host: join(cache, 'cargo-home', YARN_CACHE), container: CONTAINER_YARN_CACHE, mode: 'rw' }]
    : [
        { host: join(cache, 'cargo-home'), container: '/cargo', mode: 'ro' },
        { host: target, container: '/target-js', mode: 'rw' },
      ];
  const result = await runBuilder(channel, ['bash', '-c', jsLaneScript(steps)], {
    mounts: [
      { host: tree, container: '/src', mode: 'rw' },
      { host: out, container: '/out', mode: 'rw' },
      ...caches,
    ],
    env: network ? INSTALL_ENV : OFFLINE_ENV,
    network,
    check: false,
    timeoutMs: JS_TIMEOUT_MS,
  });

  failOnTimeout(result, { step: `${side}: JS lane`, timeoutMs: JS_TIMEOUT_MS });
}

/**
 * The root lifecycle scripts the tree's package.json defines (`ROOT_LIFECYCLE` order), which the
 * install no longer runs itself.
 *
 * @param {string} tree
 * @returns {string[]}
 */
export function rootLifecycle(tree) {
  /** @type {unknown} */
  let manifest;

  try {
    manifest = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));
  } catch {
    // No or no valid package.json: the install step fails and says so.
    return [];
  }

  const scripts = /** @type {{ scripts?: unknown }} */ (manifest ?? {}).scripts;

  if (typeof scripts !== 'object' || scripts === null) {
    return [];
  }

  return ROOT_LIFECYCLE.filter((name) => Object.hasOwn(scripts, name));
}

/**
 * Drift signatures of the regenerated files that differ from the committed ones.
 *
 * @param {readonly string[]} files
 * @param {string} pristine
 * @param {string} tree
 * @returns {Record<string, string>}
 */
function drifts(files, pristine, tree) {
  /** @type {Record<string, string>} */
  const drift = {};

  for (const file of files) {
    const committed = readIfExists(join(pristine, file));
    const regenerated = readIfExists(join(tree, file));
    const differs =
      (committed === null) !== (regenerated === null) ||
      (committed !== null && regenerated !== null && !committed.equals(regenerated));

    if (differs) {
      drift[file] = driftSignature(committed ?? Buffer.alloc(0), regenerated ?? Buffer.alloc(0));
    }
  }

  return drift;
}

/**
 * @param {string} path
 * @returns {Buffer | null}
 */
function readIfExists(path) {
  return existsSync(path) ? readFileSync(path) : null;
}
