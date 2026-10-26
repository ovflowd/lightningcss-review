/**
 * The rule-based verdict and its scope.
 *
 * Stage: report. The verdict follows from the finding counts alone (config/checks.json `$comment`):
 * any BLOCKER -> UNSAFE; else any MAJOR -> NEEDS_CHANGES; else any MINOR -> SAFE_WITH_NITS; else
 * SAFE. INCONCLUSIVE replaces SAFE / SAFE_WITH_NITS when a required stage did not run or a check is
 * INCONCLUSIVE, and replaces everything but UNSAFE when the analysis is incomplete (A3's own MAJOR
 * says nothing about the PR; only proven blockers survive).
 *
 * Scope: when every delta needs a parser flag the PR adds, the default path is untouched and the
 * verdict carries `flag <x> only`.
 */
import { pyGet } from '../core/py-value.js';
import { compareCodePoints, pyTruthy } from '../core/py.js';

/**
 * @import { CheckRow, Severity, Verdict } from '../types.js'
 * @import { EvalContext } from './context.js'
 */

/**
 * @typedef {object} VerdictScope
 * @property {string[]} flags
 * @property {number} default_requests Requests that need none of the flags.
 * @property {string} text e.g. `flag custom-functions only`.
 */

/** How many mutation generations a case may be away from a flagged case and still count. */
const MAX_PARENT_DEPTH = 3;

/**
 * The verdict from the finding counts, downgraded to INCONCLUSIVE as the module header describes.
 *
 * @param {Record<Severity, number>} counts Findings per severity.
 * @param {{ missingStages: string[], checks: CheckRow[], incomplete: string[] }} state Stages that
 *   did not run, every check row, and what A3 found missing in the analysis.
 * @returns {Verdict}
 */
export function decideVerdict(counts, state) {
  /** @type {Verdict} */
  let verdict = 'SAFE';

  if (counts.BLOCKER) {
    verdict = 'UNSAFE';
  } else if (counts.MAJOR) {
    verdict = 'NEEDS_CHANGES';
  } else if (counts.MINOR) {
    verdict = 'SAFE_WITH_NITS';
  }

  const inconclusive = state.checks.some((check) => check.status === 'INCONCLUSIVE');

  if (
    (state.missingStages.length > 0 || inconclusive) &&
    (verdict === 'SAFE' || verdict === 'SAFE_WITH_NITS')
  ) {
    verdict = 'INCONCLUSIVE';
  }

  if (state.incomplete.length > 0 && verdict !== 'UNSAFE') {
    verdict = 'INCONCLUSIVE';
  }

  return verdict;
}

/**
 * The verdict line text: `UNSAFE` or `UNSAFE (flag x only)`.
 *
 * @param {Verdict} verdict
 * @param {VerdictScope | null | undefined} scope
 * @returns {string}
 */
export function verdictLine(verdict, scope) {
  return scope ? `${verdict} (${scope.text})` : verdict;
}

/**
 * The scope of an opt-in PR (every delta needs a flag it adds), or null.
 *
 * @param {EvalContext} ctx
 * @returns {VerdictScope | null}
 */
export function verdictScope(ctx) {
  const flagOnly = pyGet(ctx.corpus, 'flag_only', null);

  if (!flagOnly || !pyTruthy(flagOnly) || ctx.deltas.size === 0) {
    return null;
  }

  const flagNames = new Set(Object.keys(flagOnly));
  const flagCases = new Set(Object.values(flagOnly).flat());
  /** @type {(id: string, depth?: number) => boolean} */
  const flagOn = (id, depth = 0) => {
    const entry = ctx.cases.get(id);
    const flags = (entry?.request || {}).flags || [];

    if (flagCases.has(id) || flags.some((flag) => flagNames.has(flag))) {
      return true;
    }

    const parent = entry?.parent;

    return pyTruthy(parent) && depth < MAX_PARENT_DEPTH && flagOn(String(parent), depth + 1);
  };

  if (![...ctx.deltas.keys()].every((id) => flagOn(id))) {
    return null;
  }

  const flags = [...flagNames].sort(compareCodePoints);

  return {
    flags,
    default_requests: [...ctx.cases.keys()].filter((id) => !flagOn(id)).length,
    text: `flag ${flags.join(', ')} only`,
  };
}
