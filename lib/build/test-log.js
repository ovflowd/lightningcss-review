/**
 * Read cargo's output: test results and failure excerpts of `cargo test`, compile errors, and the
 * per-lane log/exit/seconds files the builder script leaves behind.
 *
 * Stage: build (build/<side>/test.log -> tests.json and build.json `summary`, `compile_errors`,
 * `lanes`). Logs are read with universal newlines and invalid UTF-8 replaced: test output can
 * hold any bytes, and a log must never fail the stage.
 *
 * Invariant: test names are `<suite>::<test>` with the suite taken from the `Running` line, so the
 * same test in two suites stays two entries and base/head results pair up by name.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readPyText } from '../core/files.js';
import { pyIntOrRaise } from '../core/py-number.js';
import { pyRe } from '../core/py-re.js';
import { compareCodePoints, pySplitlines, pyStr, pyStrip } from '../core/py.js';

/** @import { BuildLane, TestsFile } from '../types.js' */

const TEST_LINE = pyRe(String.raw`^test (.+?) \.\.\. (ok|FAILED|ignored)(?:, .*)?$`);
const RUNNING = pyRe(String.raw`^\s*Running (?:unittests )?(\S+)`);
const DOCTESTS = pyRe(String.raw`^\s*Doc-tests (\S+)`);
const FAILURE_HEADER = pyRe(String.raw`^---- (.+?) stdout ----$`, 'm');
const ERROR_LINE = pyRe(String.raw`^(error(?:\[E\d+\])?: .+)$`, 'mg');
const ERROR_START = pyRe(String.raw`^error(\[E\d+\])?: `, 'm');
/** Lines of a failing test's output kept in tests.json. */
const FAILURE_LINES = 60;
/** Compile errors kept in build.json. */
const COMPILE_ERRORS = 20;
/** Error lines and tail lines kept per lane. */
const LANE_ERRORS = 8;
const LANE_TAIL_LINES = 15;

/**
 * @typedef {object} ParsedTestLog
 * @property {TestsFile['tests']} tests `<suite>::<test>` -> `ok` / `failed` / `ignored`, sorted.
 * @property {TestsFile['failures']} failures Test -> the first lines of its captured output.
 * @property {string[] | null} compile_errors
 * @property {{ passed: number, failed: number, ignored: number }} summary
 * @property {boolean} warnings_as_errors A warning failed the build under `-D warnings`.
 * @property {boolean} lockfile_outdated `--locked` refused an outdated Cargo.lock.
 */

/**
 * Every `error: …` / `error[E…]: …` line of a log.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function errorLines(text) {
  return Array.from(text.matchAll(ERROR_LINE), (match) => match[1]);
}

/**
 * Parse a `cargo test` log.
 *
 * @param {string} text
 * @returns {ParsedTestLog}
 */
export function parseTestLog(text) {
  const tests = testResults(text);
  const statuses = [...tests.values()];
  const compileFailed = text.includes('error: could not compile') || ERROR_START.test(text);

  return {
    tests: Object.fromEntries([...tests].sort((a, b) => compareCodePoints(a[0], b[0]))),
    failures: failureExcerpts(text),
    compile_errors: compileFailed ? errorLines(text).slice(0, COMPILE_ERRORS) : null,
    summary: {
      passed: statuses.filter((status) => status === 'ok').length,
      failed: statuses.filter((status) => status === 'failed').length,
      ignored: statuses.filter((status) => status === 'ignored').length,
    },
    warnings_as_errors: text.includes('implied by `-D warnings`'),
    lockfile_outdated: text.includes('needs to be updated but --locked was passed'),
  };
}

/**
 * `test <name> ... ok|FAILED|ignored` lines, named after the suite of the `Running` /
 * `Doc-tests` line above them (`lightningcss-3f2a…` -> `lightningcss`).
 *
 * @param {string} text
 * @returns {Map<string, 'ok' | 'failed' | 'ignored'>}
 */
function testResults(text) {
  /** @type {Map<string, 'ok' | 'failed' | 'ignored'>} */
  const tests = new Map();
  /** @type {string | null} */
  let suite = null;

  for (const line of pySplitlines(text)) {
    const running = RUNNING.exec(line) ?? DOCTESTS.exec(line);

    if (running) {
      const target = running[1];

      suite = target.includes('deps')
        ? /** @type {string} */ (target.split('/').at(-1)).split('-')[0]
        : target;
      continue;
    }

    const result = TEST_LINE.exec(pyStrip(line));

    if (result) {
      tests.set(
        `${pyStr(suite)}::${result[1]}`,
        /** @type {'ok' | 'failed' | 'ignored'} */ (result[2].toLowerCase()),
      );
    }
  }

  return tests;
}

/**
 * The `---- <name> stdout ----` blocks of failed tests, each cut at the `failures:` list that
 * follows the last one.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function failureExcerpts(text) {
  const blocks = text.split(FAILURE_HEADER);
  /** @type {Map<string, string>} */
  const failures = new Map();

  for (let index = 1; index < blocks.length - 1; index += 2) {
    const body = blocks[index + 1].split('\nfailures:\n')[0];

    failures.set(pyStrip(blocks[index]), pySplitlines(pyStrip(body)).slice(0, FAILURE_LINES).join('\n'));
  }

  return Object.fromEntries(failures);
}

/**
 * The extra CI lanes of one side: `lane-<name>.exit`, `.log` and `.seconds` in `out`.
 *
 * @param {string} out build/<side>/
 * @returns {Record<string, BuildLane>}
 */
export function readLanes(out) {
  const names = readdirSync(out)
    .filter((name) => name.startsWith('lane-') && name.endsWith('.exit'))
    .sort(compareCodePoints);
  /** @type {Record<string, BuildLane>} */
  const lanes = {};

  for (const exitName of names) {
    const name = exitName.slice('lane-'.length, -'.exit'.length);
    const logFile = join(out, `lane-${name}.log`);
    const secondsFile = join(out, `lane-${name}.seconds`);
    const text = existsSync(logFile) ? readPyText(logFile, { replace: true }) : '';

    lanes[name] = {
      exit: readInt(join(out, exitName), '1'),
      seconds: existsSync(secondsFile) ? readInt(secondsFile, '0') : null,
      errors: errorLines(text).slice(0, LANE_ERRORS),
      tail: pySplitlines(pyStrip(text)).slice(-LANE_TAIL_LINES).join('\n'),
    };
  }

  return lanes;
}

/**
 * The number a builder script wrote with `echo`; `fallback` when the file is empty.
 *
 * @param {string} path
 * @param {string} fallback Used when the file is empty.
 * @returns {number}
 */
export function readInt(path, fallback) {
  return pyIntOrRaise(pyStrip(readPyText(path, { replace: true })) || fallback);
}
