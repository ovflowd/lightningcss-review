/**
 * Judging one case's base and head responses: probe assertions, crashes, tuple expectation
 * buckets, cases only head can run, and tuples that could not be turned into requests.
 *
 * Stage: corpus (and `lcr probe`). Everything here is a pure function of the cases and the two
 * output maps; the browser oracle decides semantic equivalence later.
 *
 * Invariants: lists that land in corpus.json are sorted (by id, flag or a fixed key), never in
 * adapter completion order, and base and head are judged by the same rules.
 */
import { matchesExpectation } from '../build/tuples.js';
import { stableId } from '../core/ids.js';
import { PY_NON_SPACE } from '../core/py-re.js';
import { compareCodePoints, pySlice, pySorted, pyStrip, pyTruthy } from '../core/py.js';
import { dumps } from '../core/pyjson.js';
import { decodeUnicodeEscape } from './unicode-escape.js';

/** @import { AdapterResponse, CaseSource, CorpusCase, IdempotencyEntry, ProbeResult, RobustnessEntry, Side, TupleEntry, UnmappableTuple } from '../types.js' */
/** @import { TupleCase } from './sources.js' */

/** Response stages that mean the adapter itself failed, not the CSS. */
export const CRASH_STAGES = Object.freeze(['panic', 'crash', 'timeout']);

/** Error text kept in a robustness row. */
const ROBUSTNESS_ERROR_CHARS = 300;
/** Error text kept in the reason of a rejected tuple. */
const REJECTED_ERROR_CHARS = 200;
/** A request error without a flag name is grouped by this much of its text. */
const FLAG_ERROR_CHARS = 80;

const UNKNOWN_FLAG_RE = new RegExp(`unknown parser flag (${PY_NON_SPACE}+)`, 'u');

/**
 * @typedef {Record<string, AdapterResponse>} Outputs Case id -> adapter response.
 * @typedef {import('../types.js').CorpusSummary['tuples']} TupleReport corpus.json `tuples`.
 */

/**
 * A case's response, or `{}` when the adapter returned none (Python's `outputs.get(id, {})`).
 *
 * @param {Outputs} outputs
 * @param {string} id
 * @returns {Partial<AdapterResponse>}
 */
export function responseOf(outputs, id) {
  return Object.hasOwn(outputs, id) ? outputs[id] : {};
}

/**
 * @param {Partial<AdapterResponse>} response
 * @returns {boolean}
 */
function crashed(response) {
  return CRASH_STAGES.includes(/** @type {string} */ (response.stage));
}

// ---------------------------------------------------------------------------------------------
// Probes

/**
 * The text of an `output-*:"…"` assertion: without its quotes, backslash escapes decoded.
 *
 * @param {string} text Everything after the first `:`.
 * @returns {string}
 */
function assertionText(text) {
  // A lone `"` both starts and ends with a quote and comes out empty, as with Python's `[1:-1]`.
  const value = text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;

  return value.includes('\\') ? decodeUnicodeEscape(value) : value;
}

/**
 * One `output-*` assertion against a response; undefined for an unknown kind (no result is
 * recorded, as in py-final).
 *
 * @param {string} assertion
 * @param {Partial<AdapterResponse>} response
 * @returns {boolean | undefined}
 */
function checkOutput(assertion, response) {
  const colon = assertion.indexOf(':');
  const kind = colon < 0 ? assertion : assertion.slice(0, colon);
  const text = assertionText(colon < 0 ? '' : assertion.slice(colon + 1));
  const code = response.ok ? (response.code ?? null) : null;

  if (code === null) {
    return false;
  }

  switch (kind) {
    case 'output-contains':
      return code.includes(text);
    case 'output-not-contains':
      return !code.includes(text);
    case 'output-equals':
      return pyStrip(code) === pyStrip(text);
    default:
      return undefined;
  }
}

/**
 * One assertion on one side: true/false, null when another pass decides it (`idempotent` after
 * the second pass, `equivalent` from the oracle), undefined when nothing is recorded.
 *
 * @param {string} assertion
 * @param {Partial<AdapterResponse>} response
 * @returns {boolean | null | undefined}
 */
function checkAssertion(assertion, response) {
  if (assertion === 'no-panic') {
    return !crashed(response);
  }

  if (assertion === 'parse-error') {
    return !response.ok && response.stage === 'parse';
  }

  if (assertion.startsWith('output-')) {
    return checkOutput(assertion, response);
  }

  if (assertion === 'equivalent' || assertion === 'idempotent') {
    return null;
  }

  return undefined;
}

/**
 * The non-browser assertions of a probe on both sides (semantic equivalence is the oracle's).
 *
 * @param {CorpusCase & { probe: import('../types.js').ProbeMeta }} probeCase
 * @param {Partial<AdapterResponse>} base
 * @param {Partial<AdapterResponse>} head
 * @returns {Record<Side, Record<string, boolean | null>>}
 */
export function assessProbe(probeCase, base, head) {
  /** @type {Record<Side, Record<string, boolean | null>>} */
  const out = { base: {}, head: {} };

  for (const [side, response] of /** @type {const} */ ([
    ['base', base],
    ['head', head],
  ])) {
    for (const assertion of probeCase.probe.expect) {
      const result = checkAssertion(assertion, response);

      if (result !== undefined) {
        out[side][assertion] = result;
      }
    }
  }

  return out;
}

/**
 * A probe's corpus.json entry: its assertions, whether head changed the output, and crashes.
 *
 * @param {CorpusCase & { probe: import('../types.js').ProbeMeta, origin: string }} probeCase
 * @param {Partial<AdapterResponse>} base
 * @param {Partial<AdapterResponse>} head
 * @param {boolean} changed
 * @returns {ProbeResult}
 */
export function probeEntry(probeCase, base, head, changed) {
  /** @type {ProbeResult} */
  const entry = {
    id: probeCase.id,
    probe: probeCase.probe.id,
    origin: probeCase.origin,
    known: probeCase.probe.known,
    repro: probeCase.probe.repro ?? null,
    changed,
    assert: assessProbe(probeCase, base, head),
  };
  /** @type {Partial<Record<Side, string>>} */
  const crash = {};

  for (const [side, response] of /** @type {const} */ ([
    ['base', base],
    ['head', head],
  ])) {
    if (crashed(response)) {
      crash[side] = /** @type {string} */ (response.stage);
    }
  }

  if (Object.keys(crash).length) {
    entry.crash = crash;
  }

  return entry;
}

/**
 * Fill the `idempotent` assertions of probe entries from the second passes (in place).
 *
 * @param {readonly ProbeResult[]} entries
 * @param {Record<string, IdempotencyEntry>} idem Head's second pass.
 * @param {Record<string, IdempotencyEntry>} idemBase Base's second pass.
 * @returns {void}
 */
export function fillIdempotent(entries, idem, idemBase) {
  for (const entry of entries) {
    for (const [side, data] of /** @type {const} */ ([
      ['head', idem],
      ['base', idemBase],
    ])) {
      const checks = entry.assert[side];

      if (checks && Object.hasOwn(checks, 'idempotent')) {
        checks.idempotent = Object.hasOwn(data, entry.id) ? data[entry.id].stable : null;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Robustness and deltas

/**
 * Crash rows of one case (a side at most once).
 *
 * @param {CorpusCase} corpusCase
 * @param {Partial<AdapterResponse>} base
 * @param {Partial<AdapterResponse>} head
 * @param {Record<Side, RobustnessEntry[]>} robustness Appended to.
 * @returns {void}
 */
export function recordCrashes(corpusCase, base, head, robustness) {
  for (const [side, response] of /** @type {const} */ ([
    ['base', base],
    ['head', head],
  ])) {
    if (crashed(response)) {
      robustness[side].push({
        id: corpusCase.id,
        source: /** @type {CaseSource} */ (corpusCase.source),
        stage: /** @type {string} */ (response.stage),
        error: pySlice(response.error || '', 0, ROBUSTNESS_ERROR_CHARS),
      });
    }
  }
}

/**
 * Python's `==` on two normalized responses (plain JSON data: strings, booleans, null, objects).
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameJson(left, right) {
  return dumps(left, { sortKeys: true }) === dumps(right, { sortKeys: true });
}

/**
 * Count rows by `source`, in order of first appearance.
 *
 * @param {Iterable<{ source: string }>} rows
 * @returns {Record<string, number>}
 */
export function countBySource(rows) {
  /** @type {Record<string, number>} */
  const counts = {};

  for (const { source } of rows) {
    counts[source] = (Object.hasOwn(counts, source) ? counts[source] : 0) + 1;
  }

  return counts;
}

// ---------------------------------------------------------------------------------------------
// Flags only head knows

/**
 * Requests base refuses (a flag or option it does not know) and head accepts: the PR adds that
 * flag, so these cases exist only on head.
 *
 * @param {readonly CorpusCase[]} cases
 * @param {Outputs} base
 * @param {Outputs} head
 * @returns {Record<string, string[]>} Flag (or error text) -> sorted case ids, sorted by flag.
 */
export function flagOnly(cases, base, head) {
  /** @type {Map<string, string[]>} */
  const out = new Map();

  for (const corpusCase of cases) {
    const baseResponse = responseOf(base, corpusCase.id);
    const headResponse = responseOf(head, corpusCase.id);

    if (
      baseResponse.stage !== 'request' ||
      Object.keys(headResponse).length === 0 ||
      headResponse.stage === 'request'
    ) {
      continue;
    }

    const match = UNKNOWN_FLAG_RE.exec(baseResponse.error || '');
    const flag = match ? match[1] : pySlice(baseResponse.error || 'request error', 0, FLAG_ERROR_CHARS);

    const ids = out.get(flag) ?? [];

    ids.push(corpusCase.id);
    out.set(flag, ids);
  }

  return sortedFlagMap(out);
}

/**
 * @param {Map<string, Iterable<string>>} flags
 * @returns {Record<string, string[]>}
 */
function sortedFlagMap(flags) {
  return Object.fromEntries(
    pySorted(flags, ([flag]) => flag).map(([flag, ids]) => [flag, [...ids].sort(compareCodePoints)]),
  );
}

/**
 * Merge a fresh `flag_only` into a stored one; stored ids in `drop` (re-run cases) go away first.
 *
 * @param {Record<string, string[]>} old
 * @param {Record<string, string[]>} fresh
 * @param {ReadonlySet<string>} drop
 * @returns {Record<string, string[]>}
 */
export function mergeFlagOnly(old, fresh, drop) {
  /** @type {Map<string, Set<string>>} */
  const merged = new Map();

  for (const [source, keepAll] of /** @type {const} */ ([
    [old, false],
    [fresh, true],
  ])) {
    for (const [flag, ids] of Object.entries(source)) {
      const set = merged.get(flag) ?? new Set();

      merged.set(flag, set);

      for (const id of ids) {
        if (keepAll || !drop.has(id)) {
          set.add(id);
        }
      }
    }
  }

  return sortedFlagMap(new Map([...merged].filter(([, ids]) => ids.size)));
}

// ---------------------------------------------------------------------------------------------
// Tuples

/**
 * Tuples the head adapter refused as a request (a flag or option it cannot express): they are
 * unmappable too, with the adapter's reason.
 *
 * @param {readonly CorpusCase[]} cases
 * @param {Outputs} head
 * @returns {(Omit<UnmappableTuple, 'count'> & { id: string })[]}
 */
export function rejectedTuples(cases, head) {
  /** @type {(Omit<UnmappableTuple, 'count'> & { id: string })[]} */
  const out = [];

  for (const corpusCase of cases) {
    if (corpusCase.source !== 'tuple' || corpusCase.side === 'base') {
      continue;
    }

    const response = responseOf(head, corpusCase.id);

    if (response.stage === 'request') {
      out.push({
        helper: corpusCase.helper,
        test: corpusCase.test,
        line: corpusCase.line,
        side: corpusCase.side,
        in_diff: corpusCase.in_diff,
        reason: `adapter rejected the request: ${pySlice(response.error || '', 0, REJECTED_ERROR_CHARS)}`,
        id: corpusCase.id,
      });
    }
  }

  return out;
}

/**
 * In-diff tuples first; repeated calls from one line collapse into one row with a count.
 *
 * @param {readonly Omit<UnmappableTuple, 'count'>[]} rows
 * @returns {UnmappableTuple[]}
 */
export function sortUnmappable(rows) {
  /** @type {Map<string, { key: unknown[], row: UnmappableTuple }>} */
  const merged = new Map();

  for (const row of rows) {
    const key = [
      !row.in_diff,
      row.test,
      pyTruthy(row.line) ? row.line : 0,
      row.helper,
      row.id ?? '',
      row.reason,
      row.side,
    ];
    const keyText = dumps(key);
    const existing = merged.get(keyText);

    if (existing) {
      existing.row.count++;
    } else {
      merged.set(keyText, { key, row: { ...row, count: 1 } });
    }
  }

  return pySorted(merged.values(), (entry) => entry.key).map((entry) => entry.row);
}

/**
 * A changed expectation shows up as a base-only tuple and a head-only tuple with the same helper,
 * input and options; this key pairs them so the report can show old -> new.
 *
 * @param {TupleCase} tupleCase
 * @returns {string}
 */
export function pairKey(tupleCase) {
  const { expected: _expected, error: _error, ...fields } = tupleCase.tuple.fields;
  const helper = /** @type {string} */ (tupleCase.helper);

  if (helper === 'property_range_test') {
    return dumps([helper, tupleCase.request.property ?? null, tupleCase.request.value ?? null]);
  }

  return dumps([helper, stableId(fields), /** @type {string} */ (tupleCase.suffix ?? '')]);
}

/**
 * An empty `tuples` report.
 *
 * @returns {TupleReport}
 */
export function emptyTupleReport() {
  // Key order is the order of the closing log line.
  return {
    head_mismatch: [],
    new_failing_on_base: [],
    new_passing_on_base: [],
    modified: [],
    removed_changed: [],
    removed_same: [],
    base_mismatch: [],
  };
}

/**
 * Sort one tuple case into the report buckets: head failing its own expectation, base failing an
 * expectation both sides have, new tests and whether base already passes them, and base-only
 * tuples (modified when head has the same call with another expectation, else removed).
 *
 * @param {TupleCase} tupleCase
 * @param {Partial<AdapterResponse>} base
 * @param {Partial<AdapterResponse>} head
 * @param {Map<string, TupleCase>} headByKey Head-only tuple cases by `pairKey`.
 * @param {TupleReport} report Appended to.
 * @returns {void}
 */
export function classifyTuple(tupleCase, base, head, headByKey, report) {
  const baseMatches = matchesExpectation(tupleCase.expectation, base);
  const headMatches = matchesExpectation(tupleCase.expectation, head);
  const { id, helper, test, line, in_diff: inDiff, side } = tupleCase;
  /** @type {TupleEntry} */
  const entry = { id, helper, test, line, in_diff: inDiff };

  if ((side === 'both' || side === 'head') && headMatches === false) {
    report.head_mismatch.push({ ...entry, got: pyTruthy(head.code) ? head.code : (head.error ?? null) });
  }

  if (side === 'both' && baseMatches === false) {
    report.base_mismatch.push(entry);
  }

  if (side === 'head' && headMatches) {
    report[baseMatches === false ? 'new_failing_on_base' : 'new_passing_on_base'].push(entry);
  }

  if (side === 'base') {
    const partner = headByKey.get(pairKey(tupleCase));

    if (partner) {
      report.modified.push({
        ...entry,
        head_id: partner.id,
        head_line: /** @type {number} */ (partner.line),
      });
    } else {
      report[headMatches === false ? 'removed_changed' : 'removed_same'].push(entry);
    }
  }
}
