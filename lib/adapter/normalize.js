/**
 * The behavior-defining part of an adapter response.
 *
 * Stage: corpus (deltas are computed on normalized responses). Two builds behave the same on a
 * case when their normalized responses are equal. Error text carries source locations and Rust
 * Debug noise that change between revisions without any behavior change, so a failure keeps only
 * the stage and the error kind's name.
 */
import { pySlice, pyStrip, pyTruthy } from '../core/py.js';

/** @import { AdapterResponse, NormalizedResponse } from '../types.js' */

/** Errors without a `|`-separated kind keep this many leading characters. */
const UNSTRUCTURED_ERROR_CHARS = 80;

/**
 * The response reduced to what decides behavior: the output code plus CSS-module exports and
 * recognition data on success; the failing stage and the error kind on failure.
 *
 * @param {Partial<AdapterResponse>} response
 * @returns {NormalizedResponse}
 */
export function normalizeResponse(response) {
  if (response.ok) {
    /** @type {NormalizedResponse} */
    const out = { ok: true, code: response.code ?? null };

    if (pyTruthy(response.exports)) {
      out.exports = /** @type {Record<string, string>} */ (response.exports);
    }

    if (pyTruthy(response.recognition)) {
      out.recognition = response.recognition;
    }

    return out;
  }

  return { ok: false, stage: response.stage ?? null, kind: errorKind(response.error || '') };
}

/**
 * `"… | ParseError(UnexpectedToken(…)) at 1:5"` -> `"ParseError"`.
 *
 * @param {string} error
 * @returns {string}
 */
function errorKind(error) {
  if (!error.includes('|')) {
    return pySlice(error, 0, UNSTRUCTURED_ERROR_CHARS);
  }

  const afterBar = error.slice(error.indexOf('|') + 1);

  return pyStrip(afterBar).split('(')[0].split(' ')[0];
}
