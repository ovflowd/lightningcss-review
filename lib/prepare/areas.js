/**
 * Map changed files and tests to the review areas of config/areas.json (color, selectors,
 * nesting, …). Areas decide which checklists apply and which probes the reviewer must write.
 *
 * Stage: prepare (prepare.json `file_areas`, `areas`, `test_areas`), and report/oracle driver
 * (`testAreaMap`).
 *
 * Invariant: the first matching `files` rule wins, in config order, with Python's fnmatch
 * semantics (`*` crosses `/`).
 */
import { join } from 'node:path';

import { readJson } from '../core/files.js';
import { CONFIG_DIR, loadConfig } from '../core/paths.js';
import { compareCodePoints, fnmatchcase } from '../core/py.js';

/** @import { AreasConfig } from '../types.js' */

/**
 * @typedef {object} FileLines The changed lines of one file (prepare's working shape).
 * @property {string[]} [added_lines]
 * @property {string[]} [removed_lines]
 */

/**
 * The areas of each path that matches a rule of config/areas.json `files` (first match wins);
 * paths without a match are left out.
 *
 * @param {Iterable<string>} paths
 * @returns {Map<string, string[]>}
 */
export function classifyFiles(paths) {
  const rules = /** @type {AreasConfig} */ (loadConfig('areas.json')).files;
  /** @type {Map<string, string[]>} */
  const areas = new Map();

  for (const path of paths) {
    const rule = rules.find(([pattern]) => fnmatchcase(path, pattern));

    if (rule) {
      areas.set(path, rule[1]);
    }
  }

  return areas;
}

/** Library sources whose added or removed `TokenList` lines also reach custom properties. */
const LIBRARY_PREFIXES = ['src/', 'selectors/'];

/**
 * The code areas a review must cover, per changed file. A changed library line that mentions
 * `TokenList` (var()/env() substitution, unparsed values) also reaches `custom-properties`.
 *
 * @param {Map<string, FileLines>} files
 * @returns {Map<string, string[]>}
 */
export function changeAreas(files) {
  const areas = classifyFiles([...files.keys()].sort(compareCodePoints));

  for (const [path, info] of files) {
    const isLibrary =
      path.endsWith('.rs') &&
      LIBRARY_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
      path !== 'src/lib.rs';
    const changed = [...(info.added_lines ?? []), ...(info.removed_lines ?? [])];

    if (isLibrary && changed.some((line) => line.includes('TokenList'))) {
      areas.set(
        path,
        [...new Set([...(areas.get(path) ?? []), 'custom-properties'])].sort(compareCodePoints),
      );
    }
  }

  return areas;
}

/**
 * Test function name -> the areas it belongs to (config/areas.json `tests`, then
 * config/testmap.json, which only adds areas).
 *
 * @returns {Map<string, string[]>}
 */
export function testAreaMap() {
  const areas = /** @type {AreasConfig} */ (loadConfig('areas.json')).areas;
  /** @type {Map<string, string[]>} */
  const mapping = new Map();
  const areasOf = (/** @type {string} */ test) => {
    const list = mapping.get(test) ?? [];

    mapping.set(test, list);

    return list;
  };

  for (const [area, meta] of Object.entries(areas)) {
    for (const test of meta.tests ?? []) {
      areasOf(test).push(area);
    }
  }

  const extra = /** @type {{ tests?: { name: string, areas?: string[] }[] }} */ (
    readJson(join(CONFIG_DIR, 'testmap.json'), {}) ?? {}
  );

  for (const test of extra.tests ?? []) {
    const list = areasOf(test.name);

    for (const area of test.areas ?? []) {
      if (!list.includes(area)) {
        list.push(area);
      }
    }
  }

  return mapping;
}
