/**
 * The expected output of the oracle-driver and inspect commands on synthetic runs (golden.json
 * next to this file). The file is frozen: those outputs are fixed formats, so it is the record a
 * change must keep, not something to regenerate (see FIXTURES_DIR in test/helpers/index.js).
 *
 * Each scenario carries the input files of a run and the expected output of each call, with the
 * run directory replaced by `<run>`, so a test can rebuild the run in a temp dir, call the command
 * and compare the output byte for byte.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../../../lib/core/errors.js';
import { loads } from '../../../lib/core/pyjson.js';
import { captureOutput, writeFiles } from '../../helpers/index.js';
import { writeFakeAdapters } from './fake-adapter.js';

/** What the golden output holds in place of the run directory. */
export const RUN_TOKEN = '<run>';

/**
 * One recorded call of a command: `[function name, positional arguments, keyword arguments]`,
 * and what it printed (or the LcrError message it raised).
 *
 * @typedef {object} GoldenCall
 * @property {[string, unknown[], Record<string, unknown>]} call
 * @property {string} stdout
 * @property {string | null} error
 */

/**
 * @typedef {object} GoldenRun
 * @property {Record<string, string>} files Run-relative path -> exact file text.
 * @property {boolean} [adapters] The run has bin/{base,head}-adapter (the fake adapter).
 * @property {GoldenCall[]} calls
 */

/** @type {any} */
let cached = null;

/**
 * The parsed golden file (Python's number rules, so `1.0` stays a float).
 *
 * @returns {any}
 */
export function driverGolden() {
  cached ??= loads(readFileSync(join(import.meta.dirname, 'golden.json'), 'utf8'));

  return cached;
}

/**
 * Write a scenario's files (and the fake adapters it needs) into `root`.
 *
 * @param {string} root
 * @param {{ files: Record<string, string>, adapters?: boolean }} scenario
 * @returns {string} `root`
 */
export function writeScenario(root, scenario) {
  writeFiles(root, scenario.files);

  if (scenario.adapters) {
    writeFakeAdapters(root);
  }

  return root;
}

/**
 * Run a command function and return what it printed, with `runDir` replaced by RUN_TOKEN, and the
 * message of the LcrError it threw (null when it returned).
 *
 * @param {string} runDir
 * @param {() => unknown} fn
 * @returns {Promise<{ stdout: string, error: string | null }>}
 */
export async function printed(runDir, fn) {
  const { stdout, result } = await captureOutput(async () => {
    try {
      await fn();

      return null;
    } catch (error) {
      if (error instanceof LcrError) {
        return error.message;
      }

      throw error;
    }
  });

  return { stdout: stdout.replaceAll(runDir, RUN_TOKEN), error: /** @type {string | null} */ (result) };
}
