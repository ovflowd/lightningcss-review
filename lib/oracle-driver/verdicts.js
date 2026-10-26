/**
 * Bookkeeping over oracle verdicts: transition counts, errored cases, re-run selection and
 * merging, and the fingerprints that tell a stale oracle from a current one.
 *
 * Stage: oracle (after compare.mjs) and `lcr oracle --rerun`. Pure functions over oracle.json
 * shapes, except `oracleInputs`, which hashes the corpus files.
 *
 * Invariant: everything here is order-independent and sorts its output by case id, so a re-run of
 * some cases yields the same oracle.json as a full run that produced the same verdicts.
 */
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { fileSha256, readJson } from '../core/files.js';
import { log } from '../core/log.js';
import { pyGet, pyOr } from '../core/py-value.js';
import { fnmatchcase, pyRepr, pySplit, pyTruthy } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';

/** @import { CaseVerdict, CorpusSummary, OracleSummary } from '../types.js' */

/** The stage fails when more than this share of the cases errored in an engine. */
const ERRORED_SHARE = 0.05;
/** Case ids of probes and their mutations: any engine error on these fails the stage. */
const PROBE_PREFIXES = ['p-', 'm-p-'];
/** Case ids named in a progress line before it is cut with an ellipsis. */
const IDS_LOGGED = 8;
/** Case ids named in the error message. */
const IDS_IN_ERROR = 5;
const ELLIPSIS = String.fromCodePoint(0x2026);

/** @typedef {Record<string, CaseVerdict[]>} VerdictMap Case id -> its verdicts (light, dark). */

/**
 * How many verdicts ended in each latest-profile transition, sorted by transition.
 *
 * @param {VerdictMap} verdicts
 * @returns {Record<string, number>}
 */
export function transitionCounts(verdicts) {
  /** @type {Map<string, number>} */
  const counts = new Map();

  for (const verdict of Object.values(verdicts).flat()) {
    const transition = verdict.summary.latest.transition;

    counts.set(transition, (counts.get(transition) ?? 0) + 1);
  }

  return Object.fromEntries([...counts].sort(([a], [b]) => compareCodePoints(a, b)));
}

/**
 * Cases with a verdict whose latest-profile transition is `errored`, sorted.
 *
 * @param {VerdictMap} verdicts
 * @returns {string[]}
 */
export function erroredCases(verdicts) {
  return Object.entries(verdicts)
    .filter(([, list]) => list.some((verdict) => verdict.summary.latest.transition === 'errored'))
    .map(([id]) => id)
    .sort(compareCodePoints);
}

/**
 * Cases whose screenshot failed in some engine (the computed-style verdict still stands), sorted.
 *
 * @param {VerdictMap} verdicts
 * @returns {string[]}
 */
export function visualErrors(verdicts) {
  const failed = (/** @type {CaseVerdict} */ verdict) =>
    pyTruthy(pyGet(verdict.summary.latest, 'visualErrors', null)) ||
    Object.values(pyGet(verdict.summary, 'legacy', {})).some((legacy) =>
      pyTruthy(pyGet(legacy, 'visualErrors', null)),
    );

  return Object.entries(verdicts)
    .filter(([, list]) => list.some(failed))
    .map(([id]) => id)
    .sort(compareCodePoints);
}

/**
 * Log the transition counts of a stage or a re-run.
 *
 * @param {string} prefix e.g. `oracle:` or `oracle: re-ran 3 case(s);`.
 * @param {VerdictMap} verdicts
 * @returns {void}
 */
export function logTransitions(prefix, verdicts) {
  log(`${prefix} transitions ${pyRepr(transitionCounts(verdicts))}`);
}

/**
 * Log errored cases and cases without a screenshot comparison.
 *
 * @param {VerdictMap} verdicts
 * @returns {void}
 */
export function logProblems(verdicts) {
  const errored = erroredCases(verdicts);
  const shots = visualErrors(verdicts);

  if (errored.length > 0) {
    log(`oracle: ${errored.length} case(s) errored in an engine: ${idList(errored)}`);
  }

  if (shots.length > 0) {
    log(
      `oracle: ${shots.length} case(s) without a screenshot comparison (screenshot failed): ${idList(shots)}`,
    );
  }
}

/**
 * @param {readonly string[]} ids
 * @returns {string}
 */
function idList(ids) {
  return ids.slice(0, IDS_LOGGED).join(', ') + (ids.length > IDS_LOGGED ? ELLIPSIS : '');
}

/**
 * Fail the stage when engine jobs errored on probes or on more than ERRORED_SHARE of the cases:
 * an errored case has no verdict, and the report would otherwise read the gap as "no difference".
 *
 * @param {VerdictMap} verdicts
 * @returns {void}
 */
export function checkErrors(verdicts) {
  const errored = erroredCases(verdicts);
  const probes = errored.filter((id) => PROBE_PREFIXES.some((prefix) => id.startsWith(prefix)));
  const total = Object.keys(verdicts).length;

  if (errored.length > 0 && (probes.length > 0 || errored.length > ERRORED_SHARE * Math.max(1, total))) {
    throw new LcrError(
      `oracle: ${errored.length}/${total} case(s) errored in an engine (${probes.length} probe case(s)), ` +
        `e.g. ${errored.slice(0, IDS_IN_ERROR).join(', ')}`,
      { remedy: 'inspect with `lcr show`, then `lcr oracle <run> --rerun <ids>`' },
    );
  }
}

/**
 * Case ids named by a comma/space separated list of ids or globs (`m-p-color/x-*`), sorted.
 *
 * @param {string} patterns
 * @param {Iterable<string>} ids
 * @returns {string[]}
 */
export function matchIds(patterns, ids) {
  const wanted = pySplit(patterns.replaceAll(',', ' '));

  return [...ids]
    .filter((id) => wanted.some((pattern) => id === pattern || fnmatchcase(id, pattern)))
    .sort(compareCodePoints);
}

/**
 * The verdicts of a re-run, restricted to `ids`.
 *
 * @param {VerdictMap} verdicts
 * @param {readonly string[]} ids
 * @returns {VerdictMap}
 */
export function pickVerdicts(verdicts, ids) {
  return Object.fromEntries(ids.filter((id) => Object.hasOwn(verdicts, id)).map((id) => [id, verdicts[id]]));
}

/**
 * oracle.json with the cases in `ids` replaced by a re-run's result. Cases of `ids` the re-run
 * did not produce are dropped; the re-run's profiles are added; `stats.reruns` lists every case
 * ever re-run.
 *
 * @param {Partial<OracleSummary>} summary
 * @param {Pick<OracleSummary, 'verdicts'> & Partial<OracleSummary>} result
 * @param {readonly string[]} ids
 * @returns {Partial<OracleSummary>}
 */
export function mergeVerdicts(summary, result, ids) {
  const rerun = new Set(ids);
  /**
   * @template T
   * @param {Record<string, T> | undefined} old
   * @param {Record<string, T> | undefined} fresh
   * @returns {Record<string, T>}
   */
  const replace = (old, fresh) =>
    sortedByKey([
      ...Object.entries(old ?? {}).filter(([id]) => !rerun.has(id)),
      ...Object.entries(fresh ?? {}).filter(([id]) => rerun.has(id)),
    ]);
  const stats = pyGet(summary, 'stats', /** @type {Partial<OracleSummary['stats']>} */ ({}));
  const reruns = new Set([...pyGet(stats, 'reruns', []), ...ids]);

  return {
    ...summary,
    verdicts: replace(pyGet(summary, 'verdicts', {}), result.verdicts),
    dom: replace(pyGet(summary, 'dom', {}), pyGet(result, 'dom', {})),
    profiles: sortedByKey(
      Object.entries({ ...pyGet(summary, 'profiles', {}), ...pyGet(result, 'profiles', {}) }),
    ),
    stats: /** @type {OracleSummary['stats']} */ ({ ...stats, reruns: [...reruns].sort(compareCodePoints) }),
  };
}

/**
 * @template T
 * @param {[string, T][]} entries
 * @returns {Record<string, T>}
 */
function sortedByKey(entries) {
  return Object.fromEntries(entries.sort(([a], [b]) => compareCodePoints(a, b)));
}

/**
 * Fingerprints of what the oracle judged; a mismatch with the current files means a stale
 * oracle (`lcr status`).
 *
 * @param {string} runDir
 * @returns {NonNullable<OracleSummary['inputs']>}
 */
export function oracleInputs(runDir) {
  const corpusDir = join(runDir, 'corpus');
  const corpus = /** @type {Partial<CorpusSummary>} */ (pyOr(readJson(join(runDir, 'corpus.json')), {}));

  return {
    cases: fileSha256(join(corpusDir, 'cases.jsonl')),
    'outputs-base': fileSha256(join(corpusDir, 'outputs-base.jsonl')),
    'outputs-head': fileSha256(join(corpusDir, 'outputs-head.jsonl')),
    probe_files: pyGet(corpus, 'probe_files', null),
  };
}
