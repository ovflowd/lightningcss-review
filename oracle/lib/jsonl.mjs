/**
 * Line-by-line JSONL input and output for the analysis scripts.
 *
 * Stage: oracle (analysis image). Result files can exceed V8's maximum string length, so they are
 * streamed, never read into one string; a `.gz` suffix selects gzip in both directions. The gzip
 * and line handling is shared with the engine runner (runner/jsonl.cjs).
 */
import { existsSync } from 'node:fs';

import { openRowWriter, readRows } from '../runner/jsonl.cjs';

/** @import { RowWriter } from '../runner/jsonl.cjs' */

/**
 * The rows of a JSONL file; nothing when the file is not given or does not exist (an optional
 * input such as a profile that did not run).
 *
 * @param {string | null | undefined} file
 * @returns {AsyncGenerator<unknown>}
 * @yields {unknown} One parsed row; callers cast it to the file's row type.
 */
export async function* readJsonl(file) {
  if (!file || !existsSync(file)) {
    return;
  }

  yield* readRows(file);
}

/**
 * All rows of a JSONL file.
 *
 * @param {string | null | undefined} file
 * @returns {Promise<unknown[]>}
 */
export async function readAll(file) {
  return Array.fromAsync(readJsonl(file));
}

/**
 * A JSONL writer (`write(row)`, `await end()`).
 *
 * @param {string} file
 * @returns {RowWriter}
 */
export function jsonlWriter(file) {
  return openRowWriter(file);
}
