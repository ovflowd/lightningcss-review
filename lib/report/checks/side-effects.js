/**
 * Side-effect checks S1 (deltas outside the touched areas are explained), S2 (real-world output
 * size) and S3 (other open PRs touching the same files).
 *
 * Stage: report. Reads prepare.json (areas, linked issues, overlapping PRs), corpus.json (`size`),
 * the corpus cases and deltas, the oracle verdicts and the analysis classifications.
 *
 * Side effects are judged against the areas the PR directly touches (its files and its tests); the
 * blast radius explains deltas but does not excuse them.
 */
import { pyGet } from '../../core/py-value.js';
import { compareCodePoints, pyFormat, pyStr, pyTruthy } from '../../core/py.js';
import { pyFloat } from '../../core/pyjson.js';
import { caseArea, classified } from '../cases.js';
import { BAD_TRANSITIONS } from '../constants.js';

/**
 * @import { LinkedIssue, OverlappingPr } from '../../types.js'
 * @import { VerdictRecord } from '../cases.js'
 * @import { EvalContext } from '../context.js'
 */

/** @typedef {{ name: string, mode: string, base: number, head: number }} SizeRow */

/** The output modes S2 totals, with their label. */
const SIZE_MODES = /** @type {const} */ ([
  ['minify', 'minified'],
  ['lower-minify', 'lower-minify'],
]);

/**
 * Evaluate S1-S3.
 *
 * @param {EvalContext} ctx
 * @returns {void}
 */
export function sideEffectChecks(ctx) {
  outsideAreasCheck(ctx);
  sizeCheck(ctx);
  overlapCheck(ctx);
}

/**
 * S1: every delta outside the touched areas needs a classification, unless the browsers show the
 * change harmless (see `verifiedHarmless`).
 *
 * @param {EvalContext} ctx
 * @returns {void}
 */
function outsideAreasCheck(ctx) {
  const declared = new Set([...pyGet(ctx.prep, 'areas', []), ...pyGet(ctx.prep, 'test_areas', []), 'tests']);
  /** @type {string[]} */
  const outside = [];
  /** @type {string[]} */
  const accepted = [];

  for (const id of [...ctx.deltas.keys()].sort(compareCodePoints)) {
    const entry = ctx.cases.get(id);

    if (!entry) {
      continue;
    }

    const areas = caseArea(entry, ctx.testAreas, ctx.propertyAreas);

    if (areas.some((area) => declared.has(/** @type {string} */ (area)))) {
      continue;
    }

    if (verifiedHarmless(ctx.verdicts.get(id) || [])) {
      accepted.push(id);
    } else if (!classified(ctx.analysis, id, String(entry.source))) {
      outside.push(`${id} [${areas.map(pyStr).join(', ')}]`);
    }
  }

  ctx.checks.open.set('S1', outside);

  if (!pyTruthy(ctx.corpus)) {
    ctx.checks.add('S1', 'SKIP', 'corpus stage did not run');

    return;
  }

  const scope =
    [...declared]
      .filter((area) => area !== 'tests')
      .sort(compareCodePoints)
      .join(', ') || 'none';
  const note =
    accepted.length > 0
      ? `; ${accepted.length} outside delta(s) verified equivalent in every engine (accepted)`
      : '';
  const evidence =
    outside.length > 0
      ? `${outside.length} delta(s) outside the touched areas (${scope}) need classification`
      : `touched areas: ${scope}`;

  ctx.checks.add('S1', outside.length > 0 ? 'FAIL' : 'PASS', evidence + note, outside);
}

/**
 * Accepted without classification when the browsers say the PR's change is harmless: output still
 * equivalent everywhere, or exactly the same pre-existing differences as base (`neutral`), with no
 * legacy-engine regression.
 *
 * @param {readonly VerdictRecord[]} verdicts
 * @returns {boolean}
 */
function verifiedHarmless(verdicts) {
  return (
    verdicts.length > 0 &&
    verdicts.every((verdict) => {
      const latest = verdict.summary.latest;
      const unchanged = latest.transition === 'both-equivalent' || pyTruthy(latest.neutral);
      const legacyWorse = Object.values(pyGet(verdict.summary, 'legacy', {})).some(
        (legacy) =>
          BAD_TRANSITIONS.includes(legacy.transition) ||
          (legacy.transition === 'still-different' && !pyTruthy(legacy.neutral)),
      );

      return unchanged && !legacyWorse;
    })
  );
}

/**
 * S2: total real-world output size per mode, base vs head; fails above `size_growth_ratio`.
 *
 * @param {EvalContext} ctx
 * @returns {void}
 */
function sizeCheck(ctx) {
  const size = /** @type {SizeRow[]} */ (pyGet(ctx.corpus, 'size', []));

  if (!pyTruthy(size)) {
    ctx.checks.add('S2', 'SKIP', 'real-world corpus not available');

    return;
  }

  const limit = Number(ctx.config.thresholds.size_growth_ratio);
  /** @type {string[]} */
  const parts = [];
  let grewAny = false;

  for (const [mode, label] of SIZE_MODES) {
    const rows = size.filter((row) => row.mode === mode);

    if (rows.length === 0) {
      continue;
    }

    const base = rows.reduce((sum, row) => sum + Number(row.base), 0);
    const head = rows.reduce((sum, row) => sum + Number(row.head), 0);
    const ratio = base ? pyFloat((head - base) / base) : 0;

    grewAny ||= Number(ratio) > limit;
    parts.push(`${label} total ${base} -> ${head} bytes (${pyFormat(ratio, '+.3%')})`);
  }

  const grew = size
    .filter((row) => row.head > row.base)
    .map((row) => `${pyStr(row.name)}/${pyStr(row.mode)}: ${pyStr(row.base)} -> ${pyStr(row.head)} bytes`);

  ctx.checks.add('S2', grewAny ? 'FAIL' : 'PASS', parts.join('; '), grew);
}

/**
 * S3: other open PRs touching the same files; one by the same author or for the same linked issue
 * is a possible duplicate.
 *
 * @param {EvalContext} ctx
 * @returns {void}
 */
function overlapCheck(ctx) {
  const overlapping = pyGet(ctx.prep, 'overlapping_prs', /** @type {OverlappingPr[]} */ ([]));
  const author = (ctx.prep.pr || /** @type {Partial<import('../../types.js').PrMeta>} */ ({})).author ?? null;
  const mine = new Set(
    pyGet(ctx.prep, 'linked_issues', /** @type {LinkedIssue[]} */ ([])).map((issue) => issue.number),
  );
  const reason = (/** @type {OverlappingPr} */ pr) => duplicateReason(pr, author, mine);
  const duplicates = overlapping.filter((pr) => reason(pr) !== '');
  const files = (/** @type {OverlappingPr} */ pr) => pr.shared_files.join(', ');
  const items = [
    ...duplicates.map(
      (pr) => `#${pyStr(pr.number)} ${pyStr(pr.title)}: possible duplicate (${reason(pr)}; ${files(pr)})`,
    ),
    ...overlapping
      .filter((pr) => !duplicates.includes(pr))
      .map((pr) => `#${pyStr(pr.number)} ${pyStr(pr.title)} (${files(pr)})`),
  ];
  let evidence = '';

  if (overlapping.length > 0) {
    const duplicateRefs = duplicates.map((pr) => `#${pyStr(pr.number)}`).join(', ');

    evidence =
      `${overlapping.length} open PR(s) touch the same files` +
      (duplicates.length > 0 ? `; possible duplicate of ${duplicateRefs}` : '');
  }

  ctx.checks.add('S3', overlapping.length > 0 ? 'PARTIAL' : 'PASS', evidence, items, { severity: 'NOTE' });
}

/**
 * Why an overlapping PR may be a duplicate (`''` when it is not).
 *
 * @param {OverlappingPr} pr
 * @param {string | null} author
 * @param {Set<number>} linked This PR's linked issue numbers.
 * @returns {string}
 */
function duplicateReason(pr, author, linked) {
  const why = [];

  if (pyTruthy(author) && (pr.author ?? null) === author) {
    why.push('same author');
  }

  if ((pr.linked_issues || []).some((issue) => linked.has(issue))) {
    why.push('same linked issue');
  }

  return why.join(', ');
}
