/**
 * Check A3: the analysis is complete and every judgment in it is backed by evidence.
 *
 * Stage: report. The reviewer's judgment enters the report only through analysis.json; A3 is what
 * keeps it honest. It requires an intent, an answered checklist, well-formed findings, a
 * classification for every open delta slot, and evidence rules per classification:
 * - INTENDED / ACCEPTABLE_SIDE_EFFECT / ORACLE_NOISE on a case the browsers disagree with must cite
 *   the spec or WPT;
 * - a glob or `source:` pattern may not clear a regression, and a catch-all must cover one
 *   transition;
 * - REGRESSION needs an engine where base is right and head is wrong;
 * - PRE_EXISTING needs evidence that base is wrong the same way, and not on a case base renders
 *   equivalent everywhere.
 * An incomplete analysis makes the verdict INCONCLUSIVE (unless a proven blocker makes it UNSAFE).
 */
import { pyGet } from '../../core/py-value.js';
import { compareCodePoints, pyStr, pyTruthy } from '../../core/py.js';
import { caseId, caseRefs, isGlob, light, matches, wrongIn } from '../cases.js';
import {
  CATCH_ALL_PREFIXES,
  CLASSIFICATIONS,
  CLEARING_CLASSIFICATIONS,
  ISSUE_REF,
  isSeverity,
  PRE_EVIDENCE,
  SPEC_CITE,
} from '../constants.js';
import { ELLIPSIS } from '../glyphs.js';
import { snippet } from '../text.js';

/**
 * @import { AnalysisFinding, DeltaClassification } from '../../types.js'
 * @import { EvalContext } from '../context.js'
 * @import { ChecklistReview } from './analysis.js'
 * @import { OracleBuckets } from './oracle.js'
 */

/** Unanswered items and unfilled slots named in the A3 evidence before `…`. */
const MAX_NAMED_ITEMS = 10;
const MAX_NAMED_SLOTS = 5;

/** Regressed cases named when a glob tries to clear them. */
const MAX_NAMED_HITS = 3;

/** Problems spelled out in the A3 evidence line (the rest are counted). */
const MAX_EVIDENCE_PROBLEMS = 6;

/** Warnings spelled out in a PARTIAL A3 evidence line. */
const MAX_EVIDENCE_WARNINGS = 3;

/** Characters of a malformed finding's title quoted. */
const TITLE_SNIPPET_CHARS = 60;

/**
 * The cases each analysis.json delta entry covers: every known case whose first matching valid
 * classification is that entry (index-aligned with `analysis.deltas`).
 *
 * @param {EvalContext} ctx
 * @returns {string[][]}
 */
export function classificationCoverage(ctx) {
  const entries = pyGet(ctx.analysis, 'deltas', []);
  const index = new Map(entries.map((entry, position) => [entry, position]));
  /** @type {string[][]} */
  const coverage = entries.map(() => []);

  for (const id of [...ctx.known].sort(compareCodePoints)) {
    const entry = ctx.classificationOf(id);

    if (entry !== null) {
      coverage[/** @type {number} */ (index.get(entry))].push(id);
    }
  }

  return coverage;
}

/**
 * @typedef {object} CompletenessInputs
 * @property {OracleBuckets} buckets
 * @property {ChecklistReview} review
 * @property {(id: string) => boolean} baseWrong
 * @property {string[][]} coverage
 */

/**
 * Evaluate A3; returns the list of incomplete parts (empty when the analysis is complete).
 *
 * @param {EvalContext} ctx
 * @param {CompletenessInputs} inputs
 * @returns {string[]}
 */
export function completenessCheck(ctx, inputs) {
  /** @type {string[]} */
  const incomplete = [];
  /** @type {string[]} */
  const warnings = [];

  if (!pyTruthy(ctx.analysis)) {
    incomplete.push('analysis.json missing');
    ctx.checks.add('A3', 'SKIP', 'analysis.json missing: run `lcr worklist` and fill it');

    return incomplete;
  }

  incomplete.push(...structureProblems(ctx, inputs.review));
  incomplete.push(...citationProblems(ctx, inputs.buckets));
  classificationProblems(ctx, inputs, incomplete, warnings);
  incomplete.push(...inputs.review.problems);

  if (incomplete.length > 0) {
    const more =
      incomplete.length > MAX_EVIDENCE_PROBLEMS ? `; ${incomplete.length - MAX_EVIDENCE_PROBLEMS} more` : '';

    ctx.checks.add('A3', 'FAIL', incomplete.slice(0, MAX_EVIDENCE_PROBLEMS).join('; ') + more, [
      ...incomplete,
      ...warnings,
    ]);
  } else if (warnings.length > 0) {
    ctx.checks.add(
      'A3',
      'PARTIAL',
      `all slots filled; ${warnings.slice(0, MAX_EVIDENCE_WARNINGS).join('; ')}`,
      warnings,
      {
        severity: 'NOTE',
      },
    );
  } else {
    ctx.checks.add('A3', 'PASS', 'all slots filled');
  }

  return incomplete;
}

/**
 * The analysis finding ids, `F<n>` for findings without one.
 *
 * @param {readonly AnalysisFinding[]} findings
 * @returns {string[]}
 */
export function analysisFindingIds(findings) {
  return findings.map((finding, index) => pyStr(pyTruthy(finding.id) ? finding.id : `F${index + 1}`));
}

/**
 * Intent, checklist answers, findings and the finding links of answers and classifications.
 *
 * @param {EvalContext} ctx
 * @param {ChecklistReview} review
 * @returns {string[]}
 */
function structureProblems(ctx, review) {
  const intent = pyGet(
    ctx.analysis,
    'intent',
    /** @type {Partial<import('../../types.js').Analysis['intent']>} */ ({}),
  );
  const problems = [];

  if (!pyTruthy(intent.summary) || pyStr(pyGet(intent, 'kind', '|')).includes('|')) {
    problems.push('intent.summary/kind');
  }

  if (review.missing.length > 0) {
    const more = review.missing.length > MAX_NAMED_ITEMS ? ELLIPSIS : '';

    problems.push(
      `checklist items unanswered or without evidence: ${review.missing.slice(0, MAX_NAMED_ITEMS).join(', ')}${more}`,
    );
  }

  return [...problems, ...findingProblems(ctx)];
}

/**
 * Malformed analysis findings, duplicate finding ids, and links to findings that do not exist.
 *
 * @param {EvalContext} ctx
 * @returns {string[]}
 */
function findingProblems(ctx) {
  const findings = pyGet(ctx.analysis, 'findings', []);
  const ids = analysisFindingIds(findings);
  const problems = findings
    .filter(
      (finding) => !isSeverity(finding.severity) || !pyTruthy(finding.title) || !pyTruthy(finding.evidence),
    )
    .map(
      (finding) =>
        `finding without severity/title/evidence: ${snippet(finding.title ?? null, TITLE_SNIPPET_CHARS)}`,
    );

  if (new Set(ids).size !== ids.length) {
    problems.push('analysis finding ids are not unique');
  }

  /** @type {{ item?: unknown, id?: unknown, finding?: unknown }[]} */
  const linking = [...ctx.answers.values(), ...pyGet(ctx.analysis, 'deltas', [])];

  for (const entry of linking) {
    if (pyTruthy(entry.finding) && !ids.includes(pyStr(entry.finding))) {
      const name = pyTruthy(entry.item) ? entry.item : (entry.id ?? null);

      problems.push(`${pyStr(name)}: links unknown finding ${pyStr(entry.finding)}`);
    }
  }

  return problems;
}

/**
 * A case the browsers disagree with head on, cleared as intended, harmless or noise, must cite the
 * spec or WPT (once per classification entry).
 *
 * @param {EvalContext} ctx
 * @param {OracleBuckets} buckets
 * @returns {string[]}
 */
function citationProblems(ctx, buckets) {
  const mustCite = new Set(
    [...buckets.regressed, ...buckets.newBad, ...buckets.divergent, ...buckets.wptRegressed].map(caseId),
  );
  /** @type {Set<DeltaClassification>} */
  const flagged = new Set();
  const problems = [];

  for (const id of [...mustCite].sort(compareCodePoints)) {
    const entry = ctx.classificationOf(id);

    if (
      entry &&
      CLEARING_CLASSIFICATIONS.includes(entry.classification) &&
      !SPEC_CITE.test(String(pyGet(entry, 'reason', ''))) &&
      !flagged.has(entry)
    ) {
      flagged.add(entry);
      problems.push(
        `${pyStr(entry.id)}: browsers disagree with head on ${id}; an ${entry.classification} classification must cite the spec (drafts.csswg.org/w3.org URL#anchor) or a WPT file`,
      );
    }
  }

  return problems;
}

/**
 * The evidence rules per classification entry, plus open slots left empty.
 *
 * @param {EvalContext} ctx
 * @param {CompletenessInputs} inputs
 * @param {string[]} incomplete
 * @param {string[]} warnings
 * @returns {void}
 */
function classificationProblems(ctx, inputs, incomplete, warnings) {
  const { buckets, coverage } = inputs;
  const regressedNow = new Set(
    [...buckets.regressed, ...buckets.wptRegressed, ...buckets.legacyRegressed].map(caseId),
  );
  const openNow = new Set([...ctx.checks.open.values()].flat().map(caseId));
  const unfilled = [];

  for (const [index, entry] of pyGet(ctx.analysis, 'deltas', []).entries()) {
    const pattern = /** @type {string} */ (pyGet(entry, 'id', ''));
    const classification = entry.classification;

    if (!pyTruthy(classification)) {
      // An empty slot that no longer matches an open case is stale and ignored.
      if ([...openNow].some((id) => matches(pattern, id, ctx.sourceOf(id)))) {
        unfilled.push(pattern);
      }

      continue;
    }

    if (!CLASSIFICATIONS.has(classification) || !pyTruthy(entry.reason)) {
      incomplete.push(`delta classification invalid: ${pyStr(pattern)}`);
      continue;
    }

    const site = { ctx, pattern, cases: coverage[index], incomplete, warnings };

    patternProblems(site, classification, regressedNow);

    if (classification === 'REGRESSION') {
      regressionProblems(site);
    }

    if (classification === 'PRE_EXISTING') {
      preExistingProblems(site, entry, inputs.baseWrong);
    }
  }

  if (unfilled.length > 0) {
    const more = unfilled.length > MAX_NAMED_SLOTS ? ELLIPSIS : '';

    incomplete.push(
      `${unfilled.length} open delta slot(s) not classified: ${unfilled.slice(0, MAX_NAMED_SLOTS).map(pyStr).join(', ')}${more}`,
    );
  }
}

/**
 * @typedef {object} EntrySite One classification entry under review.
 * @property {EvalContext} ctx
 * @property {string} pattern
 * @property {string[]} cases The cases it covers.
 * @property {string[]} incomplete
 * @property {string[]} warnings
 */

/**
 * The light-scheme transition of a case, `none` without a verdict.
 *
 * @param {EvalContext} ctx
 * @param {string} id
 * @returns {string}
 */
function transitionOf(ctx, id) {
  const verdict = light(ctx.verdicts.get(id));

  return verdict ? verdict.summary.latest.transition : 'none';
}

/**
 * A glob may not clear regressed cases; a catch-all pattern must cover cases of one transition.
 *
 * @param {EntrySite} site
 * @param {string} classification
 * @param {Set<string>} regressedNow
 * @returns {void}
 */
function patternProblems(site, classification, regressedNow) {
  const { ctx, pattern, cases, incomplete } = site;
  const group = isGlob(pattern) || pattern.startsWith('source:');
  const hits = cases.filter((id) => regressedNow.has(id)).sort(compareCodePoints);

  if (group && hits.length > 0 && classification !== 'REGRESSION') {
    const more = hits.length > MAX_NAMED_HITS ? ELLIPSIS : '';

    incomplete.push(
      `${pattern}: a glob may not clear regressed case(s) (${hits.slice(0, MAX_NAMED_HITS).join(', ')}${more}); classify them by exact id`,
    );
  }

  const catchAll =
    pattern.startsWith('source:') ||
    (isGlob(pattern) && CATCH_ALL_PREFIXES.has(pattern.replace(/[*?]/g, '')));
  const transitions = new Set(cases.map((id) => transitionOf(ctx, id)));

  if (catchAll && transitions.size > 1) {
    incomplete.push(
      `${pattern}: a catch-all classification must cover cases of one transition (found ${[...transitions].sort(compareCodePoints).join(', ')})`,
    );
  }
}

/**
 * REGRESSION on cases the browsers call equivalent is a warning; on a still-different case it
 * needs an engine where base is right and head is wrong.
 *
 * @param {EntrySite} site
 * @returns {void}
 */
function regressionProblems(site) {
  const { ctx, pattern, cases, incomplete, warnings } = site;
  const equivalent = cases.filter((id) => transitionOf(ctx, id) === 'both-equivalent');

  if (equivalent.length > 0) {
    warnings.push(
      `${pattern}: REGRESSION covers ${equivalent.length} case(s) the browsers call both-equivalent (e.g. ${equivalent[0]})`,
    );
  }

  for (const id of cases) {
    const verdict = light(ctx.verdicts.get(id));

    if (!verdict || transitionOf(ctx, id) !== 'still-different') {
      continue;
    }

    const headWrong = new Set(wrongIn(verdict, ctx.caseOf(id), 'head'));

    if (headWrong.size > 0 && headWrong.isSubsetOf(new Set(wrongIn(verdict, ctx.caseOf(id), 'base')))) {
      const engines = [...headWrong].sort(compareCodePoints).join(', ');

      incomplete.push(
        `${pattern}: REGRESSION on ${id}, but base is wrong in every engine where head is (${engines}); use PRE_EXISTING or NEEDS_MAINTAINER_DECISION`,
      );

      break;
    }
  }
}

/**
 * PRE_EXISTING needs evidence that base is wrong the same way, and cannot cover a case base renders
 * equivalent in every engine.
 *
 * @param {EntrySite} site
 * @param {DeltaClassification} entry
 * @param {(id: string) => boolean} baseWrong
 * @returns {void}
 */
function preExistingProblems(site, entry, baseWrong) {
  const { ctx, pattern, cases, incomplete } = site;
  const text = `${pyStr(pyGet(entry, 'reason', ''))} ${pyStr(pyGet(entry, 'evidence', ''))}`;

  if (!ISSUE_REF.test(text) && !caseRefs(text, ctx.known).some(baseWrong)) {
    incomplete.push(
      `${pattern}: PRE_EXISTING needs evidence that base is wrong the same way: ${PRE_EVIDENCE}`,
    );
  }

  const regressed = cases.filter((id) => transitionOf(ctx, id) === 'regressed');

  if (regressed.length > 0) {
    incomplete.push(
      `${pattern}: PRE_EXISTING on ${regressed[0]}, which base renders equivalent in every engine`,
    );
  }
}
