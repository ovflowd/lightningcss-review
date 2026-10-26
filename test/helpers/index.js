/**
 * Shared test helpers: temporary directories, captured output, synthetic run directories and
 * the golden vectors.
 *
 * Every test file imports from here instead of writing its own temp-dir or stdout plumbing, so
 * tests stay short and clean up after themselves (`using dir = tempDir()`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { jsonFileText, jsonLineText, loads } from '../../lib/core/pyjson.js';

/** The repository root. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/**
 * test/fixtures/: shared fixtures, one subdirectory per part of the code (`build`, `core`, `driver`
 * for lib/oracle-driver and lib/inspect, `infra` for lib/cli and scripts, `report`). The
 * `golden.json` files and `infra/*.json` are frozen expected answers, recorded once from the
 * original Python implementation (tag `py-final`); they pin the on-disk and printed formats, so a
 * deliberate behavior change edits the expected value by hand and says why in the test.
 */
export const FIXTURES_DIR = join(REPO_ROOT, 'test', 'fixtures');

/**
 * A temporary directory, deleted when the `using` block ends.
 *
 * @param {string} [prefix]
 * @returns {{ path: string, [Symbol.dispose](): void }}
 */
export function tempDir(prefix = 'lcr-test-') {
  const path = mkdtempSync(join(tmpdir(), prefix));

  return {
    path,
    [Symbol.dispose]() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/**
 * Write files into a directory. `.json` values are written in the stage-file layout, `.jsonl`
 * values (arrays of rows) one row per line, strings as they are.
 *
 * @param {string} root
 * @param {Record<string, unknown>} files Relative path -> content.
 * @returns {void}
 */
export function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fileText(relative, content));
  }
}

/**
 * @param {string} relative
 * @param {unknown} content
 * @returns {string}
 */
function fileText(relative, content) {
  if (typeof content === 'string') {
    return content;
  }

  if (relative.endsWith('.jsonl')) {
    return /** @type {unknown[]} */ (content).map((row) => `${jsonLineText(row)}\n`).join('');
  }

  return jsonFileText(content);
}

/**
 * Set environment variables for the duration of a `using` block (undefined deletes one); the
 * previous values come back afterwards.
 *
 * @param {Record<string, string | undefined>} vars
 * @returns {{ [Symbol.dispose](): void }}
 */
export function withEnv(vars) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));

  setEnv(vars);

  return {
    [Symbol.dispose]() {
      setEnv(previous);
    },
  };
}

/**
 * @param {Record<string, string | undefined>} vars
 * @returns {void}
 */
function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * @typedef {object} CapturedOutput
 * @property {string} stdout
 * @property {string} stderr
 * @property {unknown} result What the function returned.
 */

/**
 * The output captured for the code running inside `captureOutput`. An async context, not a global
 * swap of `process.stdout.write`: node:test writes the reports of other tests to stdout while a
 * test awaits, and those writes must reach the runner, not the test's capture.
 *
 * @type {AsyncLocalStorage<{ stdout: string, stderr: string }>}
 */
const captureContext = new AsyncLocalStorage();

/**
 * Route writes made inside a capture context to that capture; installed once per process.
 *
 * @param {'stdout' | 'stderr'} name
 * @returns {void}
 */
function interceptWrites(name) {
  const stream = process[name];
  const original = stream.write;

  stream.write = /** @type {typeof stream.write} */ (
    function write(/** @type {unknown} */ chunk, /** @type {unknown[]} */ ...rest) {
      const captured = captureContext.getStore();

      if (!captured) {
        return Reflect.apply(original, stream, [chunk, ...rest]);
      }

      captured[name] += String(chunk);

      const callback = rest.find((argument) => typeof argument === 'function');

      if (callback) {
        process.nextTick(/** @type {() => void} */ (callback));
      }

      return true;
    }
  );
}

let intercepting = false;

/**
 * Run `fn` with the stdout and stderr it writes (`print`, `log`, direct writes) captured. Only
 * writes made by `fn` and the async work it starts are captured.
 *
 * @param {() => unknown} fn
 * @returns {Promise<CapturedOutput>}
 */
export async function captureOutput(fn) {
  if (!intercepting) {
    interceptWrites('stdout');
    interceptWrites('stderr');
    intercepting = true;
  }

  const captured = { stdout: '', stderr: '' };
  const result = await captureContext.run(captured, fn);

  return { ...captured, result };
}

/**
 * @typedef {object} PythonGolden test/fixtures/core/golden.json
 * @property {[string, string][]} float_repr `[float.hex(), repr()]`.
 * @property {{ file: string, line: string, ascii: string, ascii_indent: string }[]} dumps
 * @property {string[]} dumps_sources The values `dumps` was computed from (insertion order).
 * @property {{ parts: string, id: string }[]} stable_id `parts` is a JSON array.
 * @property {[string, string][]} repr `[value as JSON, repr(value)]`.
 * @property {[string, number | null, string, boolean][]} round `[x.hex(), ndigits, repr(result), is float]`.
 * @property {[string, string | null, string, string][]} format `[value as JSON, x.hex() for floats, spec, result]`.
 * @property {number[]} isspace Code points of str.isspace().
 * @property {[string, string, string[], string[], string[], string[]][]} strings
 *   `[text, strip(), split(), split(' '), split(None, 1), splitlines()]`.
 * @property {[string, string[]][]} splitlines
 * @property {[string, string, boolean][]} fnmatch `[pattern, name, fnmatchcase(name, pattern)]`.
 * @property {{ a: string[], b: string[], n: number, diff: string[] }[]} unified_diff
 */

/**
 * Python's answers for the core helpers (test/fixtures/core/golden.json, generated with
 * CPython 3.14).
 *
 * @returns {PythonGolden}
 */
export function pythonGolden() {
  return /** @type {PythonGolden} */ (loads(readFileSync(join(FIXTURES_DIR, 'core', 'golden.json'), 'utf8')));
}

/**
 * Parse Python's `float.hex()` output exactly.
 *
 * @param {string} text e.g. `-0x1.8000000000000p+1`.
 * @returns {number}
 */
export function fromHexFloat(text) {
  const match = /^(-)?0x([0-9a-f]+)(?:\.([0-9a-f]*))?p([-+]\d+)$/.exec(text);

  if (!match) {
    throw new RangeError(`not a hex float: ${text}`);
  }

  const [, minus, whole, fraction = '', exponent] = match;
  const mantissa = BigInt(`0x${whole}${fraction}`);
  const magnitude = Number(mantissa) * 2 ** (Number(exponent) - 4 * fraction.length);

  return minus ? -magnitude : magnitude;
}
