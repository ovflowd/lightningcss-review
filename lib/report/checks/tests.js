/**
 * Test checks T1-T5: the PR adds tests, its new test cases fail on base (they demonstrate the
 * change), changed expectations are still equivalent to their input in browsers, removed
 * expectations did not hide a behavior change, and every in-diff test case could be run.
 *
 * Stage: report. Reads prepare.json (risk flags, changed files), corpus.json (`tuples`,
 * `tuple_stats`) and the oracle verdicts of changed expectations.
 *
 * A changed expectation is recorded twice by the corpus stage: as a `modified` pair and as a
 * head-only tuple. It belongs to T3 only, so T2 leaves those head tuples out.
 */
import { pyGet } from '../../core/py-value.js';
import { pyStr, pyTruthy } from '../../core/py.js';
import { light } from '../cases.js';

/**
 * @import { CorpusSummary, TupleEntry, UnmappableTuple } from '../../types.js'
 * @import { EvalContext } from '../context.js'
 */

/** @typedef {CorpusSummary['tuple_stats']} TupleStats */

/** Head statuses that mean a changed expectation could not be verified. */
const UNVERIFIED_HEAD = Object.freeze([null, 'unknown', 'no-coverage', 'error']);

/**
 * Evaluate T1-T5.
 *
 * @param {EvalContext} ctx
 * @returns {void}
 */
export function testChecks(ctx) {
  const { corpus, prep, checks } = ctx;
  const flags = new Map(pyGet(prep, 'risk_flags', []).map((flag) => [flag.id, flag]));
  const noTests = flags.get('no-tests');

  checks.add('T1', noTests ? 'FAIL' : 'PASS', noTests ? pyStr(noTests.detail) : '');

  const tuples = pyGet(corpus, 'tuples', /** @type {Partial<Record<string, TupleEntry[]>>} */ ({}));
  const stats = pyGet(corpus, 'tuple_stats', /** @type {Partial<TupleStats>} */ ({}));
  const modified = pyGet(tuples, 'modified', /** @type {TupleEntry[]} */ ([]));
  const unmapped = pyGet(stats, 'unmappable_cases', /** @type {UnmappableTuple[]} */ ([])).filter(
    (entry) => pyTruthy(entry.in_diff) && entry.side !== 'base',
  );

  newCasesCheck(ctx, tuples, modified, unmapped);
  changedExpectationsCheck(ctx, modified);
  removedCheck(ctx, tuples);
  adapterCoverageCheck(ctx, tuples, stats, unmapped);
}

/**
 * `<test> (lib.rs:<line>)`
 *
 * @param {TupleEntry} entry
 * @returns {string}
 */
function newCaseLabel(entry) {
  return `${pyStr(entry.test)} (lib.rs:${pyStr(entry.line)})`;
}

/**
 * `<test> lib.rs:<line>`
 *
 * @param {TupleEntry} entry
 * @returns {string}
 */
function lineLabel(entry) {
  return `${pyStr(entry.test)} lib.rs:${pyStr(entry.line)}`;
}

/**
 * T2: new test cases must fail on base, or they do not demonstrate the change. When source files
 * changed but every mappable new case passes on base and some in-diff cases could not be run at
 * all, there is no conclusion.
 *
 * @param {EvalContext} ctx
 * @param {Partial<Record<string, TupleEntry[]>>} tuples
 * @param {TupleEntry[]} modified
 * @param {UnmappableTuple[]} unmapped
 * @returns {void}
 */
function newCasesCheck(ctx, tuples, modified, unmapped) {
  const { checks } = ctx;
  const changedHeads = new Set(modified.map((entry) => entry.head_id ?? null));
  const fresh = (/** @type {string} */ key) =>
    pyGet(tuples, key, /** @type {TupleEntry[]} */ ([])).filter((entry) => !changedHeads.has(entry.id));
  const failing = fresh('new_failing_on_base');
  const passing = fresh('new_passing_on_base');
  const sourceChanged = Object.keys(pyGet(ctx.prep, 'files', {})).some(
    (path) => (path.startsWith('src/') || path.startsWith('selectors/')) && path !== 'src/lib.rs',
  );
  const modNote = modified.length > 0 ? `; ${modified.length} changed expectation(s) (T3)` : '';
  const passingLabels = passing.map(newCaseLabel);

  if (!pyTruthy(ctx.corpus)) {
    checks.add('T2', 'SKIP', 'corpus stage did not run');
  } else if (failing.length === 0 && passing.length === 0) {
    checks.add('T2', 'SKIP', `no new test cases${modNote}`);
  } else if (failing.length === 0 && sourceChanged && unmapped.length > 0) {
    checks.add(
      'T2',
      'PARTIAL',
      `the ${passing.length} mappable new case(s) pass on base, but ${unmapped.length} in-diff case(s) could not be run (T5): no conclusion${modNote}`,
      passingLabels,
      { severity: 'NOTE' },
    );
  } else if (failing.length === 0 && sourceChanged) {
    checks.add(
      'T2',
      'FAIL',
      `all ${passing.length} new test case(s) already pass on base: none demonstrates the change${modNote}`,
      passingLabels,
    );
  } else if (passing.length > 0) {
    checks.add(
      'T2',
      'PARTIAL',
      `${failing.length} new case(s) fail on base (exercise the change); ${passing.length} pass on base too${modNote}`,
      passingLabels,
    );
  } else {
    checks.add('T2', 'PASS', `${failing.length} new case(s), all fail on base${modNote}`);
  }
}

/**
 * T3: a changed expectation must still render like its input in browsers. Expectations whose input
 * every engine rejects cannot be judged against base; they go to the decision bucket (O10).
 *
 * @param {EvalContext} ctx
 * @param {TupleEntry[]} modified
 * @returns {void}
 */
function changedExpectationsCheck(ctx, modified) {
  if (modified.length === 0) {
    ctx.checks.add('T3', 'SKIP', 'no existing expectation changed');

    return;
  }

  const { bad, unverified, inert } = classifyModified(ctx, modified);
  const inertNote =
    inert.length > 0 ? `; ${inert.length} with input rejected in every engine (decision bucket, O10)` : '';
  const label = (/** @type {TupleEntry} */ entry) =>
    `${pyStr(entry.test)} lib.rs:${pyStr(entry.head_line ?? null)} (${pyStr(entry.head_id)})`;

  if (bad.length > 0) {
    ctx.checks.add(
      'T3',
      'FAIL',
      `${bad.length} changed expectation(s) are not equivalent to their input in browsers${inertNote}`,
      bad.map(label),
    );
  } else if (unverified.length > 0) {
    ctx.checks.add(
      'T3',
      'PARTIAL',
      `${unverified.length} changed expectation(s) could not be verified in browsers${inertNote}`,
      unverified.map(label),
    );
  } else {
    ctx.checks.add(
      'T3',
      'PASS',
      `${modified.length - inert.length} changed expectation(s) verified${inertNote}`,
    );
  }
}

/**
 * Sort changed expectations by what the oracle said about head's output.
 *
 * @param {EvalContext} ctx
 * @param {TupleEntry[]} modified
 * @returns {{ bad: TupleEntry[], unverified: TupleEntry[], inert: TupleEntry[] }}
 */
function classifyModified(ctx, modified) {
  /** @type {{ bad: TupleEntry[], unverified: TupleEntry[], inert: TupleEntry[] }} */
  const groups = { bad: [], unverified: [], inert: [] };

  for (const entry of modified) {
    const headVerdicts = ctx.verdicts.get(/** @type {string} */ (entry.head_id));
    const verdicts = pyTruthy(headVerdicts) ? headVerdicts : ctx.verdicts.get(entry.id);
    const verdict = light(verdicts);
    const summary = verdict ? verdict.summary.latest : null;
    const transition = pyGet(summary, 'transition', 'unverified');
    const head = summary?.head ?? null;

    if (transition === 'input-rejected') {
      groups.inert.push(entry);
    } else if (transition === 'unverified' || transition === 'errored' || UNVERIFIED_HEAD.includes(head)) {
      groups.unverified.push(entry);
    } else if (head === 'different') {
      groups.bad.push(entry);
    }
  }

  return groups;
}

/**
 * T4: an expectation removed while the behavior it pinned changed.
 *
 * @param {EvalContext} ctx
 * @param {Partial<Record<string, TupleEntry[]>>} tuples
 * @returns {void}
 */
function removedCheck(ctx, tuples) {
  const changed = pyGet(tuples, 'removed_changed', /** @type {TupleEntry[]} */ ([]));
  const same = pyGet(tuples, 'removed_same', /** @type {TupleEntry[]} */ ([]));
  let evidence = '';

  if (changed.length > 0) {
    evidence = `${changed.length} expectation(s) removed and the behavior changed`;
  } else if (pyTruthy(tuples.removed_same)) {
    evidence = `${same.length} removed, behavior unchanged`;
  }

  ctx.checks.add('T4', changed.length > 0 ? 'FAIL' : 'PASS', evidence, changed.map(lineLabel));
}

/**
 * T5: in-diff test cases the adapter cannot run make every conclusion about the PR's tests
 * partial (MAJOR); recorded expectations the adapter does not reproduce are only excluded (NOTE).
 *
 * @param {EvalContext} ctx
 * @param {Partial<Record<string, TupleEntry[]>>} tuples
 * @param {Partial<TupleStats>} stats
 * @param {UnmappableTuple[]} unmapped
 * @returns {void}
 */
function adapterCoverageCheck(ctx, tuples, stats, unmapped) {
  const mismatch = pyGet(tuples, 'head_mismatch', /** @type {TupleEntry[]} */ ([]));
  const helpers = pyTruthy(stats.unmappable_helpers)
    ? `; unmappable helpers: ${pyGet(stats, 'unmappable_helpers', []).join(', ')}`
    : '';
  const mismatchItems = mismatch.map(lineLabel);

  if (unmapped.length > 0) {
    const notReproduced =
      mismatch.length > 0 ? `; ${mismatch.length} recorded expectation(s) not reproduced` : '';
    const items = unmapped.map(
      (entry) =>
        `${pyStr(entry.test)} lib.rs:${pyStr(entry.line ?? null)}: ${pyStr(pyTruthy(entry.reason) ? entry.reason : (entry.helper ?? null))}`,
    );

    ctx.checks.add(
      'T5',
      'PARTIAL',
      `${unmapped.length} test case(s) in the diff could not be run through the adapter; conclusions about the PR's tests are partial${notReproduced}${helpers}`,
      [...items, ...mismatchItems],
      { severity: 'MAJOR' },
    );

    return;
  }

  const evidence =
    mismatch.length > 0
      ? `${mismatch.length} recorded expectation(s) not reproduced by the adapter; excluded from conclusions`
      : `${pyStr(pyGet(stats, 'head_tuples', 0))} head tuples reproduced`;

  ctx.checks.add('T5', mismatch.length > 0 ? 'PARTIAL' : 'PASS', evidence + helpers, mismatchItems, {
    severity: 'NOTE',
  });
}
