/**
 * Stage 2, build: CI-parity checks and adapter builds for base and head, inside the builder image.
 *
 * Per side (side.js): `cargo fmt --check` on the pristine tree; then, on an instrumented copy
 * (adapter example + test-tuple recorder), `cargo test --all-features --no-fail-fast` with
 * `RUSTFLAGS=-D warnings` (as CI), `cargo build --example lcr_adapter`, and the lanes CI runs that
 * `cargo test` does not. Then the JS lane when bindings, the public API or generated files changed
 * (js-lane.js).
 *
 * Reads: src/<side>/, prepare.json, diff.patch. Writes: build/<side>/ (tree, logs, tuples.jsonl,
 * tests.json), bin/<side>-adapter, build.json.
 *
 * Invariants: both sides build concurrently with identical steps; target directories persist per
 * side under the cache, so consecutive reviews reuse compiled dependencies while the workspace
 * crates always rebuild (tree.js `touchTree`).
 */
import { join } from 'node:path';

import { GIB, preflightDisk } from '../core/disk.js';
import { requireDocker } from '../core/docker.js';
import { LcrError } from '../core/errors.js';
import { readJson, writeJson } from '../core/files.js';
import { log } from '../core/log.js';
import { cacheDir } from '../core/paths.js';
import { halfTheCpus, which } from '../core/proc.js';
import { pyStr, pyTruthy } from '../core/py.js';
import { GENERATED_COMPAT, jsLane, newDrift } from './js-lane.js';
import { buildSide } from './side.js';
import { isHostBuild } from './tree.js';

/** @import { Build, BuildSide, JsLane, Prepare, Side } from '../types.js' */

/** Two instrumented trees, test logs and incremental target growth per side. */
const BUILD_DISK_BYTES = 4 * GIB;
/** cargo `-j` is at least this (by default half the CPUs: the two sides build at once). */
const MIN_JOBS = 2;
/** Changes that make the generated compat files worth regenerating. */
const COMPAT_INPUTS = new Set([
  ...GENERATED_COMPAT,
  'scripts/build-prefixes.js',
  'package.json',
  'yarn.lock',
]);

/**
 * @typedef {object} BuildOptions
 * @property {boolean} [js] Also run the JS lane (yarn build/test/tsc).
 * @property {number | null} [jobs] cargo `-j` (default: half the CPUs, at least 2).
 */

/**
 * Run the build stage for both sides; writes and returns build.json.
 *
 * @param {string} runDir
 * @param {BuildOptions} [options]
 * @returns {Promise<Build>}
 */
export async function build(runDir, { js = false, jobs = null } = {}) {
  const host = isHostBuild();

  if (!host) {
    requireDocker();
  } else if (!which('cargo')) {
    throw new LcrError('LCR_BUILD=host but cargo is not on PATH', {
      remedy: 'install Rust (https://rustup.rs) or unset LCR_BUILD to build in the builder image',
    });
  }

  const prep = /** @type {Prepare | null} */ (readJson(join(runDir, 'prepare.json')));

  if (!pyTruthy(prep)) {
    throw new LcrError('run `lcr prepare` first');
  }

  preflightDisk(cacheDir(), BUILD_DISK_BYTES, 'build');

  const cargoJobs = jobs || halfTheCpus({ min: MIN_JOBS });
  const sides = await buildBothSides(runDir, cargoJobs);
  /** @type {Build} */
  const record = {
    base: sides.base,
    head: sides.head,
    js: await jsLanes(runDir, /** @type {Prepare} */ (prep), { js, host }),
  };

  writeJson(join(runDir, 'build.json'), record);

  for (const side of /** @type {const} */ (['base', 'head'])) {
    const result = record[side];

    log(
      `${side}: tests ${pyStr(result.summary)} exit=${pyStr(result.test_exit)} adapter=${result.adapter_ok ? 'ok' : 'FAILED'} tuples=${result.tuples} (${result.seconds}s)`,
    );
  }

  return record;
}

/**
 * Build base and head concurrently. A side that fails unexpectedly is reported and fails the
 * stage once both have finished (the other side's build is not interrupted).
 *
 * @param {string} runDir
 * @param {number} jobs
 * @returns {Promise<Record<Side, BuildSide>>}
 */
async function buildBothSides(runDir, jobs) {
  const sides = /** @type {const} */ (['base', 'head']);
  const settled = await Promise.allSettled(sides.map((side) => buildSide(runDir, { side, jobs })));
  /** @type {Partial<Record<Side, BuildSide>>} */
  const results = {};

  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      results[sides[index]] = outcome.value;
    } else {
      const reason = outcome.reason;

      log(
        `error: building ${sides[index]} failed: ${Error.isError(reason) ? (reason.stack ?? reason.message) : String(reason)}`,
      );
    }
  });

  if (!results.base || !results.head) {
    throw new LcrError('building a side failed (error above); see build/<side>/*.log');
  }

  return /** @type {Record<Side, BuildSide>} */ (results);
}

/**
 * The JS lane on head when the change needs it, and on base when generated files are regenerated
 * (only a drift that differs from base's is the PR's).
 *
 * @param {string} runDir
 * @param {Prepare} prep
 * @param {{ js: boolean, host: boolean }} options
 * @returns {Promise<JsLane>}
 */
async function jsLanes(runDir, prep, { js, host }) {
  const flags = new Set((prep.risk_flags ?? []).map((flag) => flag.id));
  const files = new Set(Object.keys(prep.files ?? {}));
  const runJs = js || flags.has('bindings');
  const regenCompat = !files.isDisjointFrom(COMPAT_INPUTS);
  const regenAst = flags.has('public-api') || flags.has('ast-types-changed') || files.has('node/ast.d.ts');

  if (!(runJs || regenCompat || regenAst)) {
    return { ran: false };
  }

  if (host) {
    return { ran: false, skipped: 'JS lane needs the builder image (LCR_BUILD=host)' };
  }

  /** @type {JsLane} */
  const result = await jsLane(runDir, { runJs, regenCompat, regenAst });

  if (regenCompat || regenAst) {
    const base = await jsLane(runDir, { runJs: false, regenCompat, regenAst, side: 'base' });

    result.base_failed_step = base.failed_step;
    result.base_log = base.log;

    if (!base.failed_step) {
      result.base_drift = base.drift;
      result.drift_new = newDrift(result.drift ?? {}, base.drift);
    }
  }

  return result;
}
