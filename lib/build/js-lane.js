/**
 * The JS lane: CI's test-js job (`yarn build`, `yarn test`, `yarn tsc`) and generated-file drift
 * (src/compat.rs and friends from `build-prefixes.js`, node/ast.d.ts from `yarn build-ast`),
 * inside the builder image on one side's instrumented tree.
 *
 * Stage: build (build.json `js`). Writes build/<side>/js.log and js.failed.
 *
 * Invariant: generated files can already drift on master, so drift is recorded as a
 * position-independent signature and only a head drift that differs from base's is the PR's
 * (`newDrift`).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { unifiedDiff } from '../core/difflib.js';
import { readPyText, removeFile } from '../core/files.js';
import { sha256 } from '../core/ids.js';
import { acquireLock } from '../core/lock.js';
import { cacheDir } from '../core/paths.js';
import { compareCodePoints, pySplitlines, pyStrip } from '../core/py.js';
import { runBuilder } from '../setup/images.js';
import { jsLaneScript, jsSteps } from './scripts.js';
import { failOnTimeout } from './side.js';
import { toolchainChannel } from './tree.js';

/** @import { JsLane, Side } from '../types.js' */
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
  const steps = jsSteps({ runJs, regenCompat, regenAst });
  const cache = cacheDir();

  removeFile(join(out, 'js.log'));
  removeFile(join(out, 'js.failed'));
  mkdirSync(join(cache, 'targets', 'js'), { recursive: true });

  {
    await using _lock = await acquireLock(join(cache, 'targets', 'js.lock'));
    const result = await runBuilder(toolchainChannel(tree), ['bash', '-c', jsLaneScript(steps)], {
      mounts: [
        { host: tree, container: '/src', mode: 'rw' },
        { host: join(cache, 'cargo-home'), container: '/cargo', mode: 'rw' },
        { host: join(cache, 'targets', 'js'), container: '/target-js', mode: 'rw' },
        { host: out, container: '/out', mode: 'rw' },
      ],
      network: true,
      check: false,
      timeoutMs: JS_TIMEOUT_MS,
    });

    failOnTimeout(result, { step: `${side}: JS lane`, timeoutMs: JS_TIMEOUT_MS });
  }

  const failedFile = join(out, 'js.failed');
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
