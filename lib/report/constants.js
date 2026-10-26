/**
 * The vocabulary of the check catalog evaluation: severities, classifications, transitions and the
 * patterns that recognize evidence in the reviewer's free text.
 *
 * Stage: report (and `lcr worklist`, which evaluates the same catalog). These values are part of
 * the analysis.json contract documented in SKILL.md and references/oracle.md; changing one changes
 * what an existing analysis means.
 */
import { PY_WHITESPACE } from '../core/py.js';
import { ELLIPSIS } from './glyphs.js';

/** @import { Severity } from '../types.js' */

/** Severity order, worst first. */
export const SEV_RANK = /** @type {Readonly<Record<Severity, number>>} */ (
  Object.freeze({ BLOCKER: 0, MAJOR: 1, MINOR: 2, NOTE: 3 })
);

/** The severities in rank order. */
export const SEVERITIES = /** @type {readonly Severity[]} */ (Object.freeze(Object.keys(SEV_RANK)));

/**
 * Whether a value is a severity name.
 *
 * @param {unknown} value
 * @returns {value is Severity}
 */
export function isSeverity(value) {
  return typeof value === 'string' && Object.hasOwn(SEV_RANK, value);
}

/** The classifications a reviewer may give a delta (analysis.json `deltas[].classification`). */
export const CLASSIFICATIONS = new Set([
  'INTENDED',
  'ACCEPTABLE_SIDE_EFFECT',
  'REGRESSION',
  'NEEDS_MAINTAINER_DECISION',
  'ORACLE_NOISE',
  'PRE_EXISTING',
]);

/** The answers a checklist item may have. */
export const ANSWERS = Object.freeze(['PASS', 'FAIL', 'FAIL_PRE_EXISTING', 'N/A']);

/** Classifications that say "browsers disagree, and that is fine": they must cite the spec. */
export const CLEARING_CLASSIFICATIONS = Object.freeze(['INTENDED', 'ACCEPTABLE_SIDE_EFFECT', 'ORACLE_NOISE']);

/**
 * Python's `\w` in a str pattern (Unicode letters, digits and the underscore), for patterns run
 * over free text.
 */
export const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;

const NON_SPACE = `[^${PY_WHITESPACE}]`;

/** A spec or WPT URL, the citation that clears a case the browsers disagree with. */
export const SPEC_CITE = new RegExp(
  String.raw`https?://(drafts\.csswg\.org|www\.w3\.org|drafts\.fxtf\.org|html\.spec\.whatwg\.org|wpt\.fyi|github\.com/web-platform-tests/wpt)/` +
    `${NON_SPACE}+`,
  'u',
);

/** An issue as evidence: a probe `known:` tag or a Lightning CSS issue/PR URL, never a bare `#N`. */
export const ISSUE_REF = new RegExp(
  String.raw`(?<![\p{L}\p{N}_-])(?:open-issue#\p{Nd}+|fixed-by#(?:\p{Nd}+|[0-9a-f]{7,40}))(?![\p{L}\p{N}_-])` +
    String.raw`|github\.com/parcel-bundler/lightningcss/(?:issues|pull)/\p{Nd}+`,
  'u',
);

/** What counts as evidence that base is wrong too (quoted in A3 and FAIL_PRE_EXISTING problems). */
export const PRE_EVIDENCE =
  'an issue (`open-issue#N`, `fixed-by#N` or a lightningcss issue/PR URL), a probe with an assertion that fails on base, ' +
  `a case the oracle finds wrong on base, a base tuple (\`t-${ELLIPSIS}\`) whose base output matches its recorded expectation, or a case that crashes on base`;

/** Transitions where head is worse than base in the engines that can judge the case. */
export const BAD_TRANSITIONS = Object.freeze(['regressed', 'worsened']);

/** Transitions that mean no browser verified the case. */
export const NOT_VERIFIED = Object.freeze(['unverified', 'errored', 'input-rejected']);

/** Engine statuses that are a judgment (as opposed to no coverage, unknown or an error). */
export const JUDGING = Object.freeze(['equivalent', 'near', 'different']);

/** Browser target families each engine stands for (Lightning CSS `Browsers` fields). */
export const ENGINE_FAMILIES = new Map([
  ['chromium', ['chrome', 'edge', 'opera', 'samsung', 'android']],
  ['firefox', ['firefox']],
  ['webkit', ['safari', 'ios_saf']],
]);

/** What is left of a glob without its wildcards when it names a whole source, not a family of cases. */
export const CATCH_ALL_PREFIXES = new Set(['', 't-', 'p-', 'm-', 'm-p-', 'm-t-', 'w-', 'r-']);

/** Finding order within one severity: the reviewer's findings first, plain check failures last. */
export const SOURCE_RANK = Object.freeze({ analysis: 0, checklist: 1, classification: 2, check: 3 });

/** Check groups whose failures are about cases (and so can fold into the finding that cites them). */
export const FOLDABLE_GROUPS = Object.freeze(['tests', 'oracle', 'robustness', 'side-effects']);

/** The engines whose versions the report lists (oracle.json profiles also carry node/playwright). */
export const LISTED_ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);
