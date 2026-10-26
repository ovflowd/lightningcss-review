/**
 * Optional stage, perf: release-build performance and binary size, base vs head.
 *
 * Builds the `lightningcss` CLI with the repository's real release profile (LTO,
 * codegen-units=1, panic=abort) in the builder image, then times `lightningcss --minify` on every
 * real-world file: the median of N runs, base and head interleaved (alternating which goes first)
 * to cancel machine drift. Reads src/<side>/, the real-world corpus, corpus deltas (stale-build
 * smoke test, stale.js). Writes perf/<side>-lightningcss and perf.json.
 *
 * Invariants: timing is noisy by nature, so the thresholds in config/checks.json only flag
 * consistent slowdowns; binary size is deterministic for a toolchain. When the binaries look
 * stale, perf.json carries a `skip_reason` and no timings.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { GIB, preflightDisk } from '../core/disk.js';
import { LcrError } from '../core/errors.js';
import { readJson, writeJson } from '../core/files.js';
import { acquireLock } from '../core/lock.js';
import { log } from '../core/log.js';
import { cacheDir } from '../core/paths.js';
import { run, runSync, shellJoin } from '../core/proc.js';
import { pySum } from '../core/py-number.js';
import { compareCodePoints, pyFloat, pyRound, pyStr } from '../core/py.js';
import { availableFiles } from '../fixtures/realworld.js';
import { runBuilder } from '../setup/images.js';
import { staleReason, smokeInputs, smokeOutputs } from './stale.js';
import { isHostBuild, toolchainChannel, touchTree } from './tree.js';

/** @import { PerfFile, Prepare, Side } from '../types.js' */
/** @import { PyNumber } from '../core/pyjson.js' */

/** Two release binaries and their target directories. */
const PERF_DISK_BYTES = 3 * GIB;
/** One release build; a cold release build of Lightning CSS takes several minutes. */
const RELEASE_TIMEOUT_MS = 60 * 60_000;
/** One timed CLI run on one real-world file. */
const TIMING_TIMEOUT_MS = 5 * 60_000;
/** Timing repeats per file and side. */
const DEFAULT_REPEATS = 9;
/** A file is "slower" on head beyond this ratio (above noise). */
const SLOWER_RATIO = 1.05;
const RELEASE_BUILD = 'cargo build --release --locked --features cli --bin lightningcss';
const SIDES = /** @type {const} */ (['base', 'head']);

/**
 * @typedef {typeof run} Runner
 */

/**
 * @typedef {object} ReleaseOptions
 * @property {boolean} [host] Build with the host toolchain (default: `LCR_BUILD=host`).
 * @property {Runner} [runHost] Runs the host build (tests replace it).
 */

/**
 * Build one side's release CLI and copy it to perf/<side>-lightningcss.
 *
 * @param {string} runDir
 * @param {Side} side
 * @param {ReleaseOptions} [options]
 * @returns {Promise<string>} The copied binary.
 */
export async function buildRelease(runDir, side, { host = isHostBuild(), runHost = run } = {}) {
  const tree = join(runDir, 'src', side);
  const out = join(runDir, 'perf');
  const cache = cacheDir();
  const target = join(cache, 'targets', `${side}-release`);
  const channel = toolchainChannel(tree);

  mkdirSync(out, { recursive: true });
  mkdirSync(target, { recursive: true });

  await using _lock = await acquireLock(join(cache, 'targets', `${side}-release.lock`));

  // The export carries commit times; the release target directory is shared across runs.
  touchTree(tree);

  if (host) {
    await runHost(
      ['bash', '-c', `cd ${shellJoin([tree])} && CARGO_TARGET_DIR=${shellJoin([target])} ${RELEASE_BUILD}`],
      {
        timeoutMs: RELEASE_TIMEOUT_MS,
      },
    );
  } else {
    await runBuilder(
      channel,
      ['bash', '-c', `cd /src && CARGO_HOME=/cargo CARGO_TARGET_DIR=/target ${RELEASE_BUILD}`],
      {
        mounts: [
          { host: tree, container: '/src', mode: 'ro' },
          { host: join(cache, 'cargo-home'), container: '/cargo', mode: 'rw' },
          { host: target, container: '/target', mode: 'rw' },
        ],
        network: true,
        timeoutMs: RELEASE_TIMEOUT_MS,
      },
    );
  }

  const dest = join(out, `${side}-lightningcss`);

  copyFileSync(join(target, 'release', 'lightningcss'), dest);
  chmodSync(dest, 0o755);

  return dest;
}

/**
 * Seconds one `lightningcss --minify --error-recovery` run takes, NaN when it fails.
 * (`--error-recovery`: several framework sheets carry old hacks such as `*zoom` that strict mode
 * rejects.)
 *
 * @param {string} binary
 * @param {string} css
 * @returns {number}
 */
export function timeOnce(binary, css) {
  const start = performance.now();
  const result = runSync([binary, '--minify', '--error-recovery', css], {
    check: false,
    timeoutMs: TIMING_TIMEOUT_MS,
  });
  const elapsed = (performance.now() - start) / 1000;

  if (result.timedOut) {
    throw new LcrError(`timing ${binary} on ${css} timed out after ${TIMING_TIMEOUT_MS / 1000}s`);
  }

  return result.code === 0 ? elapsed : Number.NaN;
}

/**
 * `statistics.median`. A failed sample (NaN) makes the median NaN, so the file counts as failed.
 *
 * @param {number[]} samples
 * @returns {number}
 */
function median(samples) {
  if (samples.some(Number.isNaN)) {
    return Number.NaN;
  }

  const sorted = samples.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @typedef {PerfFile['files'][number]} PerfRow
 */

/**
 * Median timings of one real-world file on both binaries, base and head interleaved (which side
 * goes first alternates) so machine drift hits both alike.
 *
 * @param {string} name
 * @param {string} path
 * @param {Record<Side, string>} binaries
 * @param {number} repeats
 * @returns {PerfRow}
 */
function timeFile(name, path, binaries, repeats) {
  /** @type {Record<Side, number[]>} */
  const samples = { base: [], head: [] };

  for (let repeat = 0; repeat < repeats; repeat++) {
    const order = repeat % 2 === 0 ? SIDES : SIDES.toReversed();

    for (const side of order) {
      samples[side].push(timeOnce(binaries[side], path));
    }
  }

  return perfRow(name, samples);
}

/**
 * perf.json `files[]` for one file: median milliseconds per side and their ratio.
 *
 * @param {string} name
 * @param {Record<Side, number[]>} samples Seconds per run, NaN for a failed run.
 * @returns {PerfRow}
 */
export function perfRow(name, samples) {
  const base = median(samples.base);
  const head = median(samples.head);

  return {
    name,
    base_ms: pyRound(base * 1000, 3),
    head_ms: pyRound(head * 1000, 3),
    // NaN is truthy in Python: a failed base still gets a (NaN) ratio; only 0.0 gets none.
    ratio: base === 0 ? null : pyRound(head / base, 4),
  };
}

/**
 * @typedef {object} PerfOptions
 * @property {number} [repeats] Timing repeats per file and side (default 9).
 * @property {[name: string, path: string][]} [files] The CSS files to time (default: the
 *   verified real-world corpus).
 */

/**
 * Run the perf stage.
 *
 * @param {string} runDir
 * @param {PerfOptions} [options]
 * @returns {Promise<PerfFile>}
 */
export async function perf(runDir, { repeats = DEFAULT_REPEATS, files = availableFiles() } = {}) {
  if (files.length === 0) {
    throw new LcrError('real-world corpus missing; run `lcr realworld`');
  }

  preflightDisk(cacheDir(), PERF_DISK_BYTES, 'perf');

  /** @type {Record<Side, string>} */
  const binaries = { base: await buildRelease(runDir, 'base'), head: await buildRelease(runDir, 'head') };
  const sizes = { base: statSync(binaries.base).size, head: statSync(binaries.head).size };
  const prep = /** @type {Partial<Prepare> | null} */ (readJson(join(runDir, 'prepare.json')));
  const changed = Object.keys(prep?.files ?? {});
  const smoke = await smokeOutputs(binaries, smokeInputs(runDir));
  const reason = staleReason({
    base: readFileSync(binaries.base),
    head: readFileSync(binaries.head),
    files: changed,
    smoke,
  });
  const data = reason
    ? skipped(reason, sizes)
    : summarizePerf(
        files.map(([name, path]) => timeFile(name, path, binaries, repeats)),
        { sizes, repeats },
      );

  writeJson(join(runDir, 'perf.json'), data);

  if (reason) {
    log(`perf: skipped: ${reason}`);
  } else {
    log(
      `perf: total ${pyStr(data.total_ms.base)}ms -> ${pyStr(data.total_ms.head)}ms (x${pyStr(data.total_ratio)}), binary ${sizes.base} -> ${sizes.head} bytes`,
    );
  }

  return data;
}

/**
 * perf.json when the binaries look stale: sizes only.
 *
 * @param {string} reason
 * @param {{ base: number, head: number }} sizes
 * @returns {PerfFile}
 */
function skipped(reason, sizes) {
  return {
    skip_reason: reason,
    repeats: 0,
    binary_bytes: sizes,
    binary_ratio: pyFloat(1),
    total_ms: { base: 0, head: 0 },
    total_ratio: null,
    slower_share: 0,
    failed_files: [],
    files: [],
  };
}

/**
 * perf.json from the per-file rows. Totals are over the files both binaries handled.
 *
 * @param {PerfRow[]} rows
 * @param {{ sizes: { base: number, head: number }, repeats: number }} context Binary sizes in
 *   bytes and the timing repeats per file.
 * @returns {PerfFile}
 */
export function summarizePerf(rows, { sizes, repeats }) {
  const valid = rows.filter(
    (row) => !Number.isNaN(Number(row.base_ms)) && !Number.isNaN(Number(row.head_ms)),
  );
  const totalBase = total(valid.map((row) => row.base_ms));
  const totalHead = total(valid.map((row) => row.head_ms));
  const slower = valid.filter((row) => row.ratio !== null && Number(row.ratio) > SLOWER_RATIO).length;

  return {
    repeats,
    binary_bytes: sizes,
    binary_ratio: pyRound(sizes.head / sizes.base, 5),
    total_ms: { base: roundTotal(totalBase, 3), head: roundTotal(totalHead, 3) },
    total_ratio: Number(totalBase) ? pyRound(Number(totalHead) / Number(totalBase), 4) : null,
    slower_share: pyRound(slower / Math.max(1, valid.length), 3),
    failed_files: rows
      .filter((row) => !valid.includes(row))
      .map((row) => row.name)
      .sort(compareCodePoints),
    files: rows,
  };
}

/**
 * Python's `sum()` of the rounded milliseconds: the int 0 for no values, else a float.
 *
 * @param {PyNumber[]} values
 * @returns {PyNumber}
 */
function total(values) {
  return values.length === 0 ? 0 : pyFloat(pySum(values.map(Number)));
}

/**
 * `round(total, n)`: an int total (no files) stays an int.
 *
 * @param {PyNumber} value
 * @param {number} ndigits
 * @returns {PyNumber}
 */
function roundTotal(value, ndigits) {
  return value === 0 ? 0 : pyRound(value, ndigits);
}
