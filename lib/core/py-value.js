/**
 * Python value semantics for the loosely typed rows of stage files and of analysis.json.
 *
 * Stage: shared by the report, the inspect commands (show, table, status, brief, worklist) and the
 * oracle driver (case selection, verdict merging). The harness was first written in Python (tag
 * `py-final`), and these readers keep its semantics because their output is part of fixed formats
 * (report.md, the inspect commands' text, oracle/cases.jsonl) that reviewers diff between runs. A
 * few Python idioms matter for that:
 * - `row.get("version", "")` returns the default only when the key is missing; a key that holds
 *   `null` gives `None`, which prints as `None`. `row.version ?? ''` would print ''.
 * - `a or b` picks `b` for every falsy `a` (`''`, `0`, `[]`, `{}`, `None`) and otherwise `a`.
 *   JavaScript's `||` treats `[]` and `{}` as true.
 * - analysis.json is written by a reviewer, so its values are not always the shape the harness
 *   writes (an `evidence` string instead of a list, a number where a string belongs). They are
 *   read with plain Python operations: `list("abc")` yields characters, `1 == 1.0 == True`.
 *
 * Invariant: `pyGet` never returns `undefined` for a JSON row (a missing value becomes the
 * fallback), so the serializer never silently drops a key that a stored row holds as `null`.
 */
import { pyTruthy } from './py.js';
import { isPyFloat } from './pyjson.js';

/**
 * The type of member `K` across a union of object types (members without it contribute nothing,
 * so for `Prepare | {}` it is Prepare's member, and for a type without `K` the fallback's type).
 *
 * @template T, K
 * @typedef {T extends unknown ? (K extends keyof T ? Exclude<T[K], undefined> : never) : never} MemberOf
 */

/**
 * Python's `mapping.get(key, fallback)`: the stored value (even `null`) when the key exists. A
 * missing mapping (`null` or `undefined`, as in `(x or {}).get(...)`) gives the fallback.
 *
 * @template {object} T
 * @template {PropertyKey} K
 * @template F
 * @param {T | null | undefined} mapping
 * @param {K} key
 * @param {F} fallback
 * @returns {MemberOf<T, K> | F}
 */
export function pyGet(mapping, key, fallback) {
  if (mapping && Object.hasOwn(mapping, key)) {
    return /** @type {Record<PropertyKey, MemberOf<T, K>>} */ (mapping)[key];
  }

  return fallback;
}

/**
 * Python's `(mapping.get(outer) or {}).get(inner)`, the usual way to read a field of an optional
 * sub-object in a loosely typed row. Any falsy outer value (missing, `null`, `{}`, `[]`, `''`, `0`)
 * reads as an empty mapping, so the result is `null` whenever the inner key is absent; an inner key
 * that holds `null` gives `null` as well, and any other stored inner value is returned as is.
 *
 * @template {object} T
 * @template {PropertyKey} K
 * @template {PropertyKey} L
 * @param {T | null | undefined} mapping
 * @param {K} outer
 * @param {L} inner
 * @returns {MemberOf<NonNullable<MemberOf<T, K>>, L> | null}
 */
export function pyGetIn(mapping, outer, inner) {
  return pyGet(pyOr(pyGet(mapping, outer, null), {}), inner, null);
}

/**
 * Python's `first or second`: `first` when it is truthy in Python, else `second`.
 *
 * @template A, B
 * @param {A} first
 * @param {B} second
 * @returns {NonNullable<A> | B}
 */
export function pyOr(first, second) {
  return pyTruthy(first) ? /** @type {NonNullable<A>} */ (first) : second;
}

/**
 * Python's `list(value)` for JSON values: a list is copied, a string yields its characters, a dict
 * its keys. Anything else (a number) is not iterable in Python; it yields nothing here.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function pyList(value) {
  if (Array.isArray(value)) {
    return [...value];
  }

  if (typeof value === 'string') {
    return Array.from(value);
  }

  if (value && typeof value === 'object' && !isPyFloat(value)) {
    return Object.keys(value);
  }

  return [];
}

/**
 * Python's `==` for JSON values: numbers (and bools, which are ints in Python) by value, strings
 * exactly, lists element-wise, dicts by key set and values.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function pyEquals(left, right) {
  if (isNumeric(left) && isNumeric(right)) {
    return Number(left) === Number(right);
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => pyEquals(item, right[index]));
  }

  if (isDict(left) && isDict(right)) {
    const keys = Object.keys(left);

    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && pyEquals(left[key], right[key]))
    );
  }

  return left === right || (left === undefined && right === null) || (left === null && right === undefined);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumeric(value) {
  return (
    typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || isPyFloat(value)
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isPyFloat(value);
}

/**
 * `value in container` for a Python list: equality, not identity.
 *
 * @param {readonly unknown[]} container
 * @param {unknown} value
 * @returns {boolean}
 */
export function pyIncludes(container, value) {
  return container.some((item) => pyEquals(item, value));
}
