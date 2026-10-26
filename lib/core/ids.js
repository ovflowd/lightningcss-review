/**
 * Content hashes and case ids.
 *
 * Stage: build (tuple identities), corpus (tuple, WPT and probe-file ids) and anything that
 * fingerprints files. Case ids are the join key between every stage file, the analysis written
 * by a reviewer and old reports, so they must equal py-final's ids exactly:
 * `sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False))[:16]` over the UTF-8 bytes.
 *
 * Invariant: hash inputs are JSON-like values made of strings, booleans, null, integers, arrays and
 * plain objects (tuple fields recorded from Rust, case ids, mode names). Integers hash as Python
 * ints; see pyjson.js for how floats would be told apart if one ever appeared.
 */
import { createHash } from 'node:crypto';

import { jsonLineText } from './pyjson.js';

/** Case ids are this many hex digits of the hash. */
const STABLE_ID_LENGTH = 16;

/**
 * SHA-256 (hex) of a string's UTF-8 bytes or of raw bytes.
 *
 * @param {string | Uint8Array} data
 * @returns {string}
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * py-final's `stable_id(*parts)`: the first 16 hex digits of the SHA-256 of the parts serialized
 * as a key-sorted JSON array.
 *
 * @param {...unknown} parts
 * @returns {string}
 */
export function stableId(...parts) {
  return sha256(jsonLineText(parts)).slice(0, STABLE_ID_LENGTH);
}
