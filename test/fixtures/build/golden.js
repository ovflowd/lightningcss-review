/**
 * py-final's answers for the lib/build and lib/prepare helpers (python-golden.json next to this
 * file, generated once with CPython 3.14 from py-final's modules). The file is frozen: it is the
 * parity record, not something to regenerate (see FIXTURES_DIR in test/helpers/index.js).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { jsonLineText, loads } from '../../../lib/core/pyjson.js';

/** @type {any} */
let cached = null;

/**
 * The parsed golden file (Python's number rules, so `1.0` stays a float).
 *
 * @returns {any}
 */
export function buildGolden() {
  cached ??= loads(readFileSync(join(import.meta.dirname, 'python-golden.json'), 'utf8'));

  return cached;
}

/**
 * `json.dumps(value, sort_keys=True, ensure_ascii=False)` of a JS result, with Maps as dicts, so
 * results compare byte for byte with the golden values (ints vs floats included).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function asPythonJson(value) {
  return jsonLineText(plain(value));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function plain(value) {
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]));
  }

  if (value instanceof Set) {
    return [...value].map(plain);
  }

  if (Array.isArray(value)) {
    return value.map(plain);
  }

  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }

  return value;
}
