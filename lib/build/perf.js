/**
 * Optional stage, perf: release-build performance and binary size, base vs head.
 *
 * Builds the `lightningcss` CLI with the repository's real release profile (LTO,
 * codegen-units=1, panic=abort) in the builder image (crates fetched first, the build itself
 * offline), then times `lightningcss --minify` on every real-world file: the median of N runs,
 * base and head interleaved (alternating which goes first) to cancel machine drift, all inside
 * one sandbox container (release-cli.js). Reads src/<side>/, the real-world corpus, corpus deltas
 * (stale-build smoke test, stale.js). Writes perf/<side>-lightningcss and perf.json.
 *
 * Invariants: timing is noisy by nature, so the thresholds in config/checks.json only flag
 * consistent slowdowns; binary size is deterministic for a toolchain. When the binaries look
 * stale, perf.json carries a `skip_reason` and no timings. head-release is reset to a copy of
 * base-release before head builds into it (target-dirs.js), except with `LCR_BUILD=host`.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GIB, preflightDisk } from '../core/disk.js';
import { LcrError } from '../core/errors.js';
import { readJson, writeJson } from '../core/files.js';
import { log } from '../core/log.js';
import { cacheDir } from '../core/paths.js';
import { run, shellJoin } from '../core/proc.js';
import { pySum } from '../core/py-number.js';
import { compareCodePoints, pyFloat, pyRound, pyStr } from '../core/py.js';
import { availableFiles } from '../fixtures/realworld.js';
import { runBuilder } from '../setup/images.js';
import { fetchCrates } from './fetch.js';
import { runCliPlan } from './release-cli.js';
import { staleReason, smokeInputs, smokeOutputs } from './stale.js';
import { lockTarget, SEEDS, seedTargets, targetDir } from './target-dirs.js';
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
/** The whole timing plan: every run at most its own timeout, plus container start-up. */
const PLAN_SLACK_MS = 5 * 60_000;

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
  const target = targetDir(cache, `${side}-release`);
  const channel = toolchainChannel(tree);

  mkdirSync(out, { recursive: true });
  mkdirSync(target, { recursive: true });

  await using _lock = await lockTarget(cache, `${side}-release`);

  if (!host && side === 'head') {
    // Base was built just before (perf builds base first), so the copy is this run's base.
    await seedTargets(cache, SEEDS.release, { baseLock: 'base-release' });
  }

  // The export carries commit times; base-release is shared across runs.
  touchTree(tree);

  if (host) {
    await runHost(
      ['bash', '-c', `cd ${shellJoin([tree])} && CARGO_TARGET_DIR=${shellJoin([target])} ${RELEASE_BUILD}`],
      {
        timeoutMs: RELEASE_TIMEOUT_MS,
      },
    );
  } else {
    mkdirSync(join(cache, 'cargo-home'), { recursive: true });
    await fetchCrates(tree, {
      channel,
      cache,
      scratch: join(out, `${side}-fetch-tree`),
      logFile: join(out, `${side}-fetch.log`),
      label: `${side} release`,
    });
    await runBuilder(
      channel,
      ['bash', '-c', `cd /src && CARGO_HOME=/cargo CARGO_TARGET_DIR=/target ${RELEASE_BUILD}`],
      {
        mounts: [
          { host: tree, container: '/src', mode: 'ro' },
          { host: join(cache, 'cargo-home'), container: '/cargo', mode: 'ro' },
          { host: target, container: '/target', mode: 'rw' },
        ],
        env: { CARGO_NET_OFFLINE: 'true' },
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
 * @typedef {{ name: string, base: (number | null)[], head: (number | null)[] }} TimedFile
 */

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
 * Median timings of every real-world file on both binaries: one plan for the runner, which
 * interleaves base and head (which side goes first alternates) so machine drift hits both alike.
 * A run that hangs is an `LcrError` naming it.
 *
 * @param {[name: string, path: string][]} files
 * @param {Record<Side, string>} binaries
 * @param {{ repeats: number, host: boolean, channel: string }} options
 * @returns {Promise<PerfRow[]>}
 */
async function timeFiles(files, binaries, { repeats, host, channel }) {
  const plan = {
    kind: /** @type {const} */ ('time'),
    binaries,
    files,
    repeats,
    timeoutMs: TIMING_TIMEOUT_MS,
  };
  const runs = files.length * repeats * Object.keys(binaries).length;
  const { rows, timedOut } =
    /** @type {{ rows: TimedFile[], timedOut: { side: Side, name: string } | null }} */ (
      await runCliPlan(plan, { host, channel, timeoutMs: TIMING_TIMEOUT_MS * runs + PLAN_SLACK_MS })
    );

  if (timedOut) {
    const css = files.find(([name]) => name === timedOut.name)?.[1];

    throw new LcrError(
      `timing ${binaries[timedOut.side]} on ${css} timed out after ${TIMING_TIMEOUT_MS / 1000}s`,
    );
  }

  // JSON carries a failed run as null; it is NaN again for the median.
  const seconds = (/** @type {(number | null)[]} */ samples) => samples.map((value) => value ?? Number.NaN);

  return rows.map(({ name, base, head }) => perfRow(name, { base: seconds(base), head: seconds(head) }));
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
  const where = { host: isHostBuild(), channel: toolchainChannel(join(runDir, 'src', 'base')) };
  const smoke = await smokeOutputs(binaries, smokeInputs(runDir), where);
  const reason = staleReason({
    base: readFileSync(binaries.base),
    head: readFileSync(binaries.head),
    files: changed,
    smoke,
  });
  const data = reason
    ? skipped(reason, sizes)
    : summarizePerf(await timeFiles(files, binaries, { repeats, ...where }), { sizes, repeats });

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
