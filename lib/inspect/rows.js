/**
 * Fast lookups in a run's JSONL files and the engine abbreviations the inspect views share.
 *
 * Stage: inspect (`lcr show`, `lcr table`). Run files can hold hundreds of thousands of rows and
 * real-world sheets of several megabytes, so a lookup streams the file and parses only the lines
 * that contain the key's serialized form; parsing every row would make `lcr show` take seconds.
 *
 * Invariant: the prefilter is exact for files written by `writeJsonl`, including runs written by
 * earlier versions, because every version serializes a member as `"key": <json value>` with these
 * separators.
 * A line that merely contains the needle elsewhere is parsed and then rejected by the key check.
 */
import { iterLines } from '../core/files.js';
import { dumps, loads } from '../core/pyjson.js';

/** @import { CaseBase, CaseSource, ProbeMeta, TupleExpectation } from '../types.js' */

/**
 * A corpus case read loosely: the fields of every case source, all optional except the common
 * ones, so a reader can look at `entry.probe` or `entry.parent` without first narrowing on
 * `source`; a field a source lacks simply reads as missing.
 *
 * @typedef {CaseBase & {
 *   source: CaseSource,
 *   origin?: string,
 *   side?: string,
 *   helper?: string,
 *   test?: string,
 *   line?: number,
 *   in_diff?: boolean,
 *   mode?: string,
 *   name?: string,
 *   expectation?: TupleExpectation | null,
 *   probe?: ProbeMeta | null,
 *   mutation?: string,
 *   parent?: string | null,
 *   area?: string | null,
 *   dom?: string | null,
 *   wpt?: ({ kind?: string, expected?: unknown } & Record<string, unknown>) | null,
 * }} AnyCase
 */

/** One-letter engine names for the compact columns (`bad engines base CW`). */
const ENGINE_ABBR = new Map([
  ['chromium', 'C'],
  ['firefox', 'F'],
  ['webkit', 'W'],
]);

/**
 * Engines as one-letter abbreviations in the given order (unknown engines keep their name), or
 * `-` when there are none.
 *
 * @param {Iterable<string>} engines
 * @returns {string}
 */
export function abbreviateEngines(engines) {
  return [...engines].map((engine) => ENGINE_ABBR.get(engine) ?? engine).join('') || '-';
}

/**
 * Rows of a JSONL file whose `key` equals `value`; `[]` when the file does not exist.
 *
 * @param {string} path
 * @param {string} key
 * @param {string} value
 * @returns {unknown[]} Cast to the file's row type at the call.
 */
export function findRows(path, key, value) {
  const needle = `"${key}": ${dumps(value, { ensureAscii: false })}`;
  /** @type {unknown[]} */
  const rows = [];

  for (const line of iterLines(path)) {
    if (!line.includes(needle)) {
      continue;
    }

    const row = /** @type {Record<string, unknown>} */ (loads(line));

    if (row[key] === value) {
      rows.push(row);
    }
  }

  return rows;
}
