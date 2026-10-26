/**
 * Build one side (base or head): `cargo fmt --check` on the pristine tree, then on an
 * instrumented copy (adapter example + test-tuple recorder) `cargo test` with the recorder, the
 * adapter build and the extra CI lanes, retried step by step when CI parity fails for a reason
 * that would hide every other result.
 *
 * Stage: build. Reads src/<side>/, prepare.json, diff.patch. Writes build/<side>/ (tree, fmt.txt,
 * test/adapter/lane logs and exits, tuples.jsonl, tests.json) and bin/<side>-adapter.
 *
 * Invariants: the shared target directory of a side is locked for the whole sequence, so a
 * concurrent review cannot rebuild or overwrite the adapter between our build and our copy. Base
 * and head run the same steps with the same flags (only their own toolchain differs).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import {
  countPyLines,
  readJson,
  readPyText,
  removeFile,
  universalNewlines,
  writeJson,
  writeText,
} from '../core/files.js';
import { acquireLock } from '../core/lock.js';
import { cacheDir } from '../core/paths.js';
import { returncode, run, shellJoin, which } from '../core/proc.js';
import { pyRe } from '../core/py-re.js';
import { compareCodePoints } from '../core/py.js';
import { builderTag, ensureBuilder, runBuilder } from '../setup/images.js';
import { injectAdapter, injectDump } from './inject.js';
import { builderScript, fmtScript, lanesFor } from './scripts.js';
import { errorLines, parseTestLog, readInt, readLanes } from './test-log.js';
import { freshCopy, isHostBuild, toolchainChannel } from './tree.js';

/** @import { BuildSide, Prepare, Side } from '../types.js' */
/** @import { Mount } from '../core/docker.js' */
/** @import { RunResult } from '../core/proc.js' */
/** @import { ParsedTestLog } from './test-log.js' */

/** One cargo test + adapter build + lanes sequence; a cold instrumented build plus the test suite. */
const BUILD_TIMEOUT_MS = 2 * 60 * 60_000;
/** `cargo fmt --check` and `strip`. */
const SHORT_TIMEOUT_MS = 10 * 60_000;
/** The flags CI builds with: any warning is an error. */
const CI_RUSTFLAGS = '-D warnings';
/** build.json keeps at most this many compiler error lines of a failed adapter build. */
const ADAPTER_ERRORS = 10;
const FMT_DIFF = pyRe(String.raw`^Diff in (\S+?)(?: at line|:)`, 'mg');
/** Outputs of a previous build of this side that must not leak into this one. */
const STALE_OUTPUTS = ['tuples.jsonl', 'adapter', 'test.log', 'adapter.log'];

/**
 * @typedef {object} SideContext
 * @property {string} runDir
 * @property {Side} side
 * @property {number} jobs
 * @property {boolean} host `LCR_BUILD=host`.
 * @property {string} channel The tree's Rust channel.
 * @property {string} cache
 * @property {string} out build/<side>/
 * @property {string} tree build/<side>/tree (the instrumented copy).
 */

/**
 * Build one side under its target-directory lock; resolves to its build.json record.
 *
 * @param {string} runDir
 * @param {{ side: Side, jobs: number }} options `jobs` is cargo's `-j`.
 * @returns {Promise<BuildSide>}
 */
export async function buildSide(runDir, { side, jobs }) {
  await using _lock = await acquireLock(join(cacheDir(), 'targets', `${side}.lock`));

  return buildLocked(runDir, side, jobs);
}

/**
 * @param {string} runDir
 * @param {Side} side
 * @param {number} jobs
 * @returns {Promise<BuildSide>}
 */
async function buildLocked(runDir, side, jobs) {
  const pristine = join(runDir, 'src', side);
  const out = join(runDir, 'build', side);
  const host = isHostBuild();
  const channel = toolchainChannel(pristine);
  const cache = cacheDir();
  /** @type {SideContext} */
  const context = { runDir, side, jobs, host, channel, cache, out, tree: join(out, 'tree') };

  mkdirSync(out, { recursive: true });

  if (!host) {
    await ensureBuilder(channel);
  }

  mkdirSync(join(cache, 'cargo-home'), { recursive: true });
  mkdirSync(join(cache, 'targets', side), { recursive: true });

  const fmt = await checkFormat(context, pristine);
  const injection = instrument(context.tree, pristine);

  for (const name of STALE_OUTPUTS) {
    removeFile(join(out, name));
  }

  const started = Date.now();
  const prep = /** @type {Partial<Prepare>} */ (readJson(join(runDir, 'prepare.json')) ?? {});
  const lanes = lanesFor(prep, runDir);

  for (const name of readdirSync(out).filter((entry) => entry.startsWith('lane-'))) {
    removeFile(join(out, name));
  }

  const { parsed, attempts } = await testWithFallbacks(context, lanes);
  const adapterOk = installAdapter(context);

  if (adapterOk && which('strip')) {
    // Debug symbols are ~75% of the binary and never needed by the harness.
    await run(['strip', '--strip-debug', adapterPath(context)], {
      check: false,
      timeoutMs: SHORT_TIMEOUT_MS,
    });
  }

  writeJson(join(out, 'tests.json'), { tests: parsed.tests, failures: parsed.failures });

  return sideRecord(context, { fmt, injection, attempts, parsed, adapterOk, started });
}

/**
 * `cargo fmt --check` on the pristine tree. CI runs `cargo fmt` without `--check`, so this is
 * advisory: it becomes a finding, never a failed build.
 *
 * @param {SideContext} context
 * @param {string} pristine
 * @returns {Promise<RunResult>}
 */
async function checkFormat(context, pristine) {
  // A failing check is the finding itself, so a non-zero exit is not an error.
  const options = { check: false, timeoutMs: SHORT_TIMEOUT_MS };
  /** @type {Mount[]} */
  const mounts = [
    { host: pristine, container: '/src', mode: 'ro' },
    { host: join(context.cache, 'cargo-home'), container: '/cargo', mode: 'rw' },
  ];
  const fmt = context.host
    ? await run(['bash', '-c', fmtScript(shellJoin([pristine]))], options)
    : await runBuilder(context.channel, ['bash', '-c', fmtScript('/src', { prefix: 'CARGO_HOME=/cargo ' })], {
        ...options,
        mounts,
      });

  failOnTimeout(fmt, { step: `${context.side}: cargo fmt --check`, timeoutMs: SHORT_TIMEOUT_MS });

  writeText(join(context.out, 'fmt.txt'), universalNewlines(fmt.stdout) + universalNewlines(fmt.stderr));

  return fmt;
}

/**
 * A fresh instrumented copy: the adapter example plus the recorder. A tree whose helpers the
 * recorder cannot find still builds (its tuples are then missing, which the report shows).
 *
 * @param {string} tree
 * @param {string} pristine
 * @returns {BuildSide['injection']}
 */
function instrument(tree, pristine) {
  freshCopy(pristine, tree);
  injectAdapter(tree);

  try {
    return injectDump(tree);
  } catch (error) {
    if (error instanceof LcrError) {
      return { error: error.message };
    }

    throw error;
  }
}

/**
 * @typedef {{ rustflags: string, locked: boolean, exit: number | null }} Attempt
 */

/**
 * CI parity first (`-D warnings`, `--locked`). Fall back step by step, so an outdated lockfile or
 * a warning is reported as a finding instead of hiding every other result.
 *
 * @param {SideContext} context
 * @param {string[]} lanes
 * @returns {Promise<{ parsed: ParsedTestLog, attempts: Attempt[] }>}
 */
async function testWithFallbacks(context, lanes) {
  /** @type {Attempt[]} */
  const attempts = [];
  const attempt = async (/** @type {string} */ rustflags, /** @type {boolean} */ locked) => {
    attempts.push(await runAttempt(context, { rustflags, locked, lanes }));

    const log = join(context.out, 'test.log');

    return parseTestLog(existsSync(log) ? readPyText(log, { replace: true }) : '');
  };
  let parsed = await attempt(CI_RUSTFLAGS, true);
  const lockfileOutdated = parsed.lockfile_outdated;
  const locked = !lockfileOutdated;

  if (lockfileOutdated) {
    parsed = await attempt(CI_RUSTFLAGS, false);
  }

  const warningsAsErrors = parsed.warnings_as_errors;

  if (warningsAsErrors) {
    parsed = await attempt('', locked);
  }

  return {
    parsed: { ...parsed, lockfile_outdated: lockfileOutdated, warnings_as_errors: warningsAsErrors },
    attempts,
  };
}

/**
 * Run the builder script once. Without `-D warnings` the build uses its own target directory, so
 * the CI-flag artifacts stay warm.
 *
 * @param {SideContext} context
 * @param {{ rustflags: string, locked: boolean, lanes: string[] }} options
 * @returns {Promise<Attempt>}
 */
async function runAttempt(context, { rustflags, locked, lanes }) {
  const { cache, side, out, tree } = context;
  const target = rustflags ? join(cache, 'targets', side) : join(cache, 'targets', `${side}-nowarn`);
  const script = { jobs: context.jobs, rustflags, locked, lanes };

  mkdirSync(target, { recursive: true });

  // The script's own exit status means nothing: every step records its status under /out.
  const options = { check: false, timeoutMs: BUILD_TIMEOUT_MS };
  /** @type {Mount[]} */
  const mounts = [
    { host: tree, container: '/src', mode: 'rw' },
    { host: join(cache, 'cargo-home'), container: '/cargo', mode: 'rw' },
    { host: target, container: '/target', mode: 'rw' },
    { host: out, container: '/out', mode: 'rw' },
  ];
  const cargo = process.env.CARGO_HOME || join(cache, 'cargo-home');
  const result = context.host
    ? await run(
        ['bash', '-c', builderScript({ ...script, paths: { src: tree, out, target, cargo } })],
        options,
      )
    : await runBuilder(context.channel, ['bash', '-c', builderScript(script)], {
        ...options,
        mounts,
        network: true,
      });

  failOnTimeout(result, { step: `${side}: cargo test and build`, timeoutMs: BUILD_TIMEOUT_MS });

  const exitFile = join(out, 'test.exit');

  return { rustflags, locked, exit: existsSync(exitFile) ? readInt(exitFile, '1') : null };
}

/**
 * A step that hit its timeout is a hung build: an expected failure, so an `LcrError` naming the
 * step rather than a half-written build.json.
 *
 * @param {RunResult} result
 * @param {{ step: string, timeoutMs: number }} limit What ran (for the message) and its timeout.
 * @returns {void}
 */
export function failOnTimeout(result, { step, timeoutMs }) {
  if (result.timedOut) {
    throw new LcrError(`${step} timed out after ${timeoutMs / 1000}s`);
  }
}

/**
 * @param {SideContext} context
 * @returns {string}
 */
function adapterPath(context) {
  return join(context.runDir, 'bin', `${context.side}-adapter`);
}

/**
 * Move a built adapter to bin/<side>-adapter (executable).
 *
 * @param {SideContext} context
 * @returns {boolean} Whether the adapter was built.
 */
function installAdapter(context) {
  const built = join(context.out, 'adapter');

  if (!existsSync(built)) {
    return false;
  }

  mkdirSync(join(context.runDir, 'bin'), { recursive: true });
  copyFileSync(built, adapterPath(context));
  chmodSync(adapterPath(context), 0o755);
  removeFile(built);

  return true;
}

/**
 * @typedef {object} SideOutcome
 * @property {RunResult} fmt
 * @property {BuildSide['injection']} injection
 * @property {Attempt[]} attempts
 * @property {ParsedTestLog} parsed
 * @property {boolean} adapterOk
 * @property {number} started `Date.now()` before the first attempt.
 */

/**
 * build.json `<side>`.
 *
 * @param {SideContext} context
 * @param {SideOutcome} outcome
 * @returns {BuildSide}
 */
function sideRecord(context, { fmt, injection, attempts, parsed, adapterOk, started }) {
  const { out } = context;
  const adapterLog = join(out, 'adapter.log');
  const testSeconds = join(out, 'test.seconds');
  const tuples = join(out, 'tuples.jsonl');
  const fmtFiles = Array.from(universalNewlines(fmt.stdout).matchAll(FMT_DIFF), (match) => match[1]);

  return {
    side: context.side,
    toolchain: context.channel,
    image: context.host ? 'host' : builderTag(context.channel),
    fmt_ok: returncode(fmt) === 0,
    fmt_files: [...new Set(fmtFiles)].sort(compareCodePoints),
    injection,
    attempts,
    test_exit: attempts.at(-1)?.exit ?? null,
    test_seconds: existsSync(testSeconds) ? readInt(testSeconds, '0') : null,
    adapter_ok: adapterOk,
    adapter_errors: errorLines(existsSync(adapterLog) ? readPyText(adapterLog, { replace: true }) : '').slice(
      0,
      ADAPTER_ERRORS,
    ),
    tuples: existsSync(tuples) ? countPyLines(tuples) : 0,
    lanes: readLanes(out),
    seconds: Math.trunc((Date.now() - started) / 1000),
    summary: parsed.summary,
    compile_errors: parsed.compile_errors,
    warnings_as_errors: parsed.warnings_as_errors,
    lockfile_outdated: parsed.lockfile_outdated,
  };
}
