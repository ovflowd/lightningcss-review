/**
 * Robustness checks R1 (no new panic, crash or timeout) and R2 (changed cases stay stable under a
 * second minify pass).
 *
 * Stage: report. Reads corpus.json (`robustness`, `idempotency_failures`,
 * `idempotency_preexisting`). Only instability the PR introduces is charged; what base shares is a
 * pre-existing note.
 */
import { pyGet } from '../../core/py-value.js';
import { pyStr, pyTruthy } from '../../core/py.js';
import { snippet } from '../text.js';

/**
 * @import { RobustnessEntry } from '../../types.js'
 * @import { EvalContext } from '../context.js'
 */

/** Characters of a crash message shown in R1. */
const CRASH_SNIPPET_CHARS = 120;

/**
 * @typedef {object} RobustnessOutcome
 * @property {string[]} unstable Changed cases unstable on head only (R2's items; T6 skips them).
 * @property {Set<string>} baseCrashes Case ids that crash on base (evidence that base is wrong).
 */

/**
 * Evaluate R1 and R2.
 *
 * @param {EvalContext} ctx
 * @returns {RobustnessOutcome}
 */
export function robustnessChecks(ctx) {
  const { corpus, checks } = ctx;
  const robustness = pyGet(corpus, 'robustness', { head: [], base: [] });
  const baseCrashes = new Set(pyGet(robustness, 'base', []).map((entry) => entry.id));

  if (!pyTruthy(corpus)) {
    checks.add('R1', 'SKIP', 'corpus stage did not run');
    checks.add('R2', 'SKIP', 'corpus stage did not run');

    return { unstable: [], baseCrashes };
  }

  crashCheck(ctx, pyGet(robustness, 'head', []), baseCrashes);

  return { unstable: stabilityCheck(ctx), baseCrashes };
}

/**
 * R1: crashes on head that base does not have fail; crashes on both sides are a note.
 *
 * @param {EvalContext} ctx
 * @param {RobustnessEntry[]} headCrashes
 * @param {Set<string>} baseCrashes
 * @returns {void}
 */
function crashCheck(ctx, headCrashes, baseCrashes) {
  const fresh = headCrashes.filter((entry) => !baseCrashes.has(entry.id));
  const listed = fresh.length > 0 ? fresh : headCrashes;
  const items = listed.map(
    (entry) => `${pyStr(entry.id)} ${pyStr(entry.stage)}: ${snippet(entry.error, CRASH_SNIPPET_CHARS)}`,
  );

  if (fresh.length > 0) {
    ctx.checks.add('R1', 'FAIL', `${fresh.length} new panic/crash/timeout`, items);
  } else if (headCrashes.length > 0) {
    ctx.checks.add('R1', 'PARTIAL', `${headCrashes.length} pre-existing (also on base)`, items, {
      severity: 'NOTE',
    });
  } else {
    ctx.checks.add('R1', 'PASS', '', items, { severity: 'NOTE' });
  }
}

/**
 * R2: a case that changed (a delta, a PR probe, or a mutation of a PR probe) must stay stable under
 * a second minify pass where base is stable.
 *
 * @param {EvalContext} ctx
 * @returns {string[]} The changed cases unstable on head only.
 */
function stabilityCheck(ctx) {
  const { corpus, checks } = ctx;
  const relevant = (/** @type {string} */ id) => {
    const entry = ctx.caseOf(id);

    return (
      ctx.deltas.has(id) ||
      pyGet(entry, 'origin', null) === 'pr' ||
      pyStr(pyGet(entry, 'parent', '')).startsWith('p-')
    );
  };
  const unstable = pyGet(corpus, 'idempotency_failures', []).filter(relevant);
  const preExisting = pyGet(corpus, 'idempotency_preexisting', []).filter(relevant);
  const preNote = preExisting.length > 0 ? `; ${preExisting.length} unstable on base too (pre-existing)` : '';

  if (unstable.length > 0) {
    checks.add(
      'R2',
      'FAIL',
      `${unstable.length} changed case(s) are not stable under a second minify pass, while base is${preNote}`,
      unstable,
    );
  } else if (preExisting.length > 0) {
    checks.add(
      'R2',
      'PARTIAL',
      `${preExisting.length} case(s) are unstable under a second minify pass on base and head alike (pre-existing)`,
      preExisting,
      { severity: 'NOTE' },
    );
  } else {
    checks.add('R2', 'PASS', '');
  }

  return unstable;
}
