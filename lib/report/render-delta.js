/**
 * Section 4 of report.md, the behavioral delta: case and delta counts per source, oracle
 * transitions, then one block per case for regressions, still-different changes, fixes, legacy
 * regressions, unverified deltas, decisions and pre-existing cases.
 *
 * Stage: report. Reads the evaluation plus corpus/outputs-{base,head}.jsonl for the case blocks.
 *
 * Invariant: the same evaluation always renders the same bytes, in the fixed report layout (see
 * render.js).
 */
import { pyGet } from '../core/py-value.js';
import { compareCodePoints, pyCompare, pyStr, pyTruthy } from '../core/py.js';
import { dumps } from '../core/pyjson.js';
import { formatTargets } from '../targets/targets.js';
import { classified, describeCase, readOutputs, wrongIn } from './cases.js';
import { BAD_TRANSITIONS } from './constants.js';
import { ARROW, EM_DASH, MIDDLE_DOT, NOT_EQUAL } from './glyphs.js';
import { diffExcerpt, fence, snippet } from './text.js';

/**
 * @import { AdapterResponse, DeltaClassification, EngineEntry, ProfileSummary } from '../types.js'
 * @import { CaseRecord, VerdictRecord } from './cases.js'
 * @import { Evaluation } from './evaluate.js'
 * @import { RenderLimits } from './render.js'
 */

/** The sources in table order. */
const SOURCES = /** @type {const} */ (['tuple', 'probe', 'mutation', 'wpt', 'realworld']);

/** Value differences, rejected declarations, and the characters of their parts, per engine line. */
const MAX_DIFFS = 3;
const MAX_REJECTED = 2;
const ERROR_CHARS = 120;
const VALUE_CHARS = 80;
const REJECTED_VALUE_CHARS = 60;

/**
 * @typedef {object} DeltaView What the case blocks read.
 * @property {Evaluation} evaluation
 * @property {Map<string, Partial<AdapterResponse>>} base
 * @property {Map<string, Partial<AdapterResponse>>} head
 * @property {RenderLimits} limits
 */

/**
 * @callback CasePredicate Whether a verdict puts its case in a group.
 * @param {string} id
 * @param {ProfileSummary} summary The current-engine summary.
 * @param {VerdictRecord} verdict
 * @returns {boolean}
 */

/**
 * Section 4.
 *
 * @param {Evaluation} evaluation
 * @param {string} runDir
 * @param {RenderLimits} limits
 * @returns {string[]}
 */
export function renderDelta(evaluation, runDir, limits) {
  /** @type {DeltaView} */
  const view = { evaluation, base: readOutputs(runDir, 'base'), head: readOutputs(runDir, 'head'), limits };

  return [
    ...countTables(evaluation),
    ...verdictGroups(view),
    ...unverifiedGroup(view),
    ...decisionGroup(view),
    ...preExistingGroup(view),
  ];
}

/**
 * @param {Evaluation} evaluation
 * @returns {Map<string, VerdictRecord[]>}
 */
function verdictsOf(evaluation) {
  return new Map(Object.entries(pyGet(evaluation.oracle, 'verdicts', {})));
}

/**
 * The cases and deltas per source, the transition counts and the oracle's selection stats.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function countTables(evaluation) {
  const { corpus, oracle } = evaluation;
  const cases = pyGet(corpus, 'cases', {});
  const deltas = pyGet(corpus, 'deltas', {});
  const lines = [
    '## 4. Behavioral delta',
    '',
    `| Source | Cases | Deltas (base ${NOT_EQUAL} head) |`,
    '|---|---|---|',
    ...SOURCES.map(
      (source) => `| ${source} | ${pyStr(pyGet(cases, source, 0))} | ${pyStr(pyGet(deltas, source, 0))} |`,
    ),
    '',
  ];
  const transitions = transitionCountsBySource(evaluation);

  if (transitions.length > 0) {
    lines.push(
      'Oracle transitions (current engines):',
      '',
      '| Source | Transition | Count |',
      '|---|---|---|',
    );
    lines.push(
      ...transitions.map(([source, transition, count]) => `| ${source} | ${transition} | ${count} |`),
      '',
    );
  }

  const stats = pyGet(
    oracle,
    'stats',
    /** @type {Partial<import('../types.js').OracleSummary['stats']>} */ ({}),
  );

  if (pyTruthy(stats)) {
    const reasons = Object.entries(pyGet(stats, 'by_reason', {}))
      .sort(([a], [b]) => compareCodePoints(a, b))
      .map(([reason, count]) => `${reason}=${pyStr(count)}`);

    lines.push(
      `Oracle selection: ${pyStr(pyGet(stats, 'selected', 0))} of ${pyStr(pyGet(stats, 'candidates', 0))} candidate case(s); not run: ${pyStr(pyGet(stats, 'dropped', 0))}. By reason: ${reasons.join(', ')}`,
      '',
    );
  }

  return lines;
}

/**
 * `[source, transition, count]` over every verdict, sorted.
 *
 * @param {Evaluation} evaluation
 * @returns {[string, string, number][]}
 */
function transitionCountsBySource(evaluation) {
  /** @type {Map<string, [string, string, number]>} */
  const counts = new Map();

  for (const verdicts of verdictsOf(evaluation).values()) {
    for (const verdict of verdicts) {
      const source = pyStr(pyGet(evaluation.cases.get(verdict.case) ?? {}, 'source', '?'));
      const transition = verdict.summary.latest.transition;
      const key = dumps([source, transition]);
      const row = counts.get(key) ?? [source, transition, 0];

      row[2] += 1;
      counts.set(key, row);
    }
  }

  return [...counts.values()].sort((a, b) => pyCompare([a[0], a[1]], [b[0], b[1]]));
}

/**
 * 4.1-4.4: the case groups defined by verdicts.
 *
 * @param {DeltaView} view
 * @returns {string[]}
 */
function verdictGroups(view) {
  const { evaluation, limits } = view;
  const extended = evaluation.extended;
  /** @type {[string, CasePredicate][]} */
  const groups = [
    [
      '4.1 Regressions',
      (id, summary) =>
        (BAD_TRANSITIONS.includes(summary.transition) && !extended.has(id)) ||
        (summary.transition === 'introduced' && summary.head === 'different'),
    ],
    [
      '4.2 Changed and still different from input',
      (_id, summary) => summary.transition === 'still-different' && !pyTruthy(summary.neutral),
    ],
    ['4.3 Fixed by this PR', (_id, summary) => summary.transition === 'fixed'],
    [
      '4.4 Lowering regressions (legacy engines)',
      (_id, _summary, verdict) =>
        Object.values(pyGet(verdict.summary, 'legacy', {})).some((legacy) =>
          BAD_TRANSITIONS.includes(legacy.transition),
        ),
    ],
  ];
  const lines = [];

  for (const [heading, predicate] of groups) {
    const ids = matchingCases(evaluation, predicate);

    lines.push(`### ${heading} (${ids.length})`, '');

    if (heading.startsWith('4.3') && evaluation.probeFixed.length > 0) {
      lines.push(fixedProbesLine(evaluation.probeFixed, limits.cap), '');
    }

    for (const id of ids.slice(0, limits.cap)) {
      lines.push(...caseBlock(view, id), '');
    }

    if (ids.length > limits.cap) {
      lines.push(`_${ids.length - limits.cap} more in oracle.json_`, '');
    }
  }

  return lines;
}

/**
 * @param {Evaluation} evaluation
 * @param {CasePredicate} predicate
 * @returns {string[]}
 */
function matchingCases(evaluation, predicate) {
  const ids = new Set();

  for (const [id, verdicts] of verdictsOf(evaluation)) {
    if (verdicts.some((verdict) => predicate(id, verdict.summary.latest, verdict))) {
      ids.add(id);
    }
  }

  return [.../** @type {Set<string>} */ (ids)].sort(compareCodePoints);
}

/**
 * @param {string[]} fixed
 * @param {number} cap
 * @returns {string}
 */
function fixedProbesLine(fixed, cap) {
  const more = fixed.length > cap ? ` (+${fixed.length - cap} more)` : '';
  const shown = fixed.slice(0, cap).map((entry) => `\`${entry}\``);

  return `Probe assertions that fail on base and pass on head: ${shown.join(', ')}${more}`;
}

/**
 * What a side printed, or its error as a CSS comment.
 *
 * @param {Partial<AdapterResponse>} response
 * @returns {string | null}
 */
function shown(response) {
  if (pyTruthy(response.ok)) {
    return response.code ?? null;
  }

  return `/* ${pyStr(response.stage ?? null)} error: ${pyStr(response.error ?? null)} */`;
}

/**
 * Indent a multi-line block by two spaces (the case blocks are list items).
 *
 * @param {string} text
 * @returns {string}
 */
function indent(text) {
  return `  ${text.replaceAll('\n', '\n  ')}`;
}

/**
 * One case: what it is, its input, base and head output, and every verdict with the engine
 * details.
 *
 * @param {DeltaView} view
 * @param {string} id
 * @returns {string[]}
 */
function caseBlock(view, id) {
  const { evaluation, limits } = view;
  const entry = evaluation.cases.get(id) ?? /** @type {Record<string, never>} */ ({});
  const request = /** @type {Partial<import('../types.js').AdapterRequest>} */ (
    pyGet(entry, 'request', {}) ?? {}
  );
  const base = shown(view.base.get(id) ?? {});
  const head = shown(view.head.get(id) ?? {});
  const lines = [
    `- **${id}** ${EM_DASH} ${describeCase(entry)}; targets: ${formatTargets(request.targets)}; minify: ${pyStr(request.minify ?? null)}`,
    '',
  ];

  if (entry.source === 'realworld') {
    lines.push(
      `  base ${ARROW} head (changed part):`,
      indent(fence(diffExcerpt(base, head, limits.snippet), 'diff')),
    );
  } else {
    const input =
      request.kind !== 'property'
        ? (request.css ?? null)
        : `${pyStr(request.property ?? null)}: ${pyStr(request.value ?? null)}`;
    const outputs = `${snippet(base, limits.snippet)}\n/* ---- head ---- */\n${snippet(head, limits.snippet)}`;

    lines.push(
      '  input:',
      indent(fence(snippet(input, limits.snippet), 'css')),
      `  base ${ARROW} head:`,
      indent(fence(outputs, 'css')),
    );
  }

  for (const verdict of verdictsOf(evaluation).get(id) ?? []) {
    lines.push(...verdictLines(verdict, entry));
  }

  return lines;
}

/**
 * The verdict summary line of a case, its engine details and its legacy transitions.
 *
 * @param {VerdictRecord} verdict
 * @param {CaseRecord | Record<string, never>} entry
 * @returns {string[]}
 */
function verdictLines(verdict, entry) {
  const summary = verdict.summary.latest;
  const list = (/** @type {string[]} */ names) => names.join(', ') || 'none';
  const dot = ` ${MIDDLE_DOT} `;
  const live = pyTruthy(summary.inertLive)
    ? `${dot}input inert, output live in: ${(summary.inertLive ?? []).join(', ')}`
    : '';
  const lines = [
    `  oracle (${pyStr(verdict.scheme ?? null)}): base **${pyStr(summary.base)}**, head **${pyStr(summary.head)}** ${ARROW} \`${summary.transition}\`` +
      `${dot}base wrong in: ${list(wrongIn(verdict, entry, 'base'))}${dot}head wrong in: ${list(wrongIn(verdict, entry, 'head'))}${live}`,
  ];
  const engines = Object.entries(pyGet(verdict, 'latest', {})).sort(([a], [b]) => compareCodePoints(a, b));

  for (const [engine, engineEntry] of engines) {
    const bits = engineBits(/** @type {EngineEntry} */ (engineEntry));

    if (bits.length > 0) {
      lines.push(`    - ${engine} ${pyStr(pyGet(engineEntry, 'version', ''))}: ${bits.join('; ')}`);
    }
  }

  const legacy = Object.entries(pyGet(verdict.summary, 'legacy', {})).sort(([a], [b]) =>
    compareCodePoints(a, b),
  );

  for (const [profile, profileSummary] of legacy) {
    lines.push(
      `    - ${profile}: base ${pyStr(profileSummary.base)}, head ${pyStr(profileSummary.head)} ${ARROW} \`${profileSummary.transition}\``,
    );
  }

  return lines;
}

/**
 * What one engine says about head: its error, the first value differences, rejected declarations
 * without a surviving fallback, and the detail status.
 *
 * @param {EngineEntry} entry
 * @returns {string[]}
 */
function engineBits(entry) {
  /** @type {Partial<import('../types.js').EngineVariant>} */
  const head = Object.hasOwn(entry, 'variants') ? (entry.variants?.head ?? {}) : {};
  const bits = [];

  if (pyTruthy(entry.error)) {
    bits.push(`error: ${snippet(entry.error, ERROR_CHARS)}`);
  }

  for (const diff of pyGet(head, 'diffs', []).slice(0, MAX_DIFFS)) {
    bits.push(
      `\`${pyStr(diff.key)}\` ${pyStr(diff.prop)}: \`${snippet(diff.ref, VALUE_CHARS)}\` vs \`${snippet(diff.val, VALUE_CHARS)}\` (${pyStr(diff.level)})`,
    );
  }

  bits.push(...rejectedBits(head));

  const detail = head.detail;

  if (Object.hasOwn(head, 'detail') && isDict(detail)) {
    bits.push(pyStr(detail.status ?? null));
  }

  return bits;
}

/**
 * The first rejected declarations of a variant that have no surviving fallback.
 *
 * @param {Partial<import('../types.js').EngineVariant>} variant
 * @returns {string[]}
 */
function rejectedBits(variant) {
  const rejected = variant.rejected;
  const decls = isDict(rejected) ? rejected.decls || [] : [];

  return decls
    .slice(0, MAX_REJECTED)
    .filter((decl) => !pyTruthy(decl.fallbackSurvives))
    .map((decl) => `rejected \`${pyStr(decl.prop)}: ${snippet(decl.value, REJECTED_VALUE_CHARS)}\``);
}

/**
 * @template T
 * @param {T} value
 * @returns {value is T & object}
 */
function isDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `**CLASSIFICATION**: reason`, or `unclassified`.
 *
 * @param {DeltaClassification | null} entry
 * @returns {string}
 */
function classificationText(entry) {
  return entry ? `**${entry.classification}**: ${pyStr(entry.reason)}` : 'unclassified';
}

/**
 * @param {Evaluation} evaluation
 * @param {string} id
 * @returns {DeltaClassification | null}
 */
function classificationOf(evaluation, id) {
  return classified(evaluation.analysis, id, pyStr(pyGet(evaluation.cases.get(id) ?? {}, 'source', '')));
}

/**
 * 4.5: deltas no verdict judged (not run, or every verdict unverified or errored).
 *
 * @param {DeltaView} view
 * @returns {string[]}
 */
function unverifiedGroup(view) {
  const { evaluation, limits } = view;
  const verdicts = verdictsOf(evaluation);
  const transitionsOf = (/** @type {string} */ id) =>
    (verdicts.get(id) ?? []).map((verdict) => verdict.summary.latest.transition);
  const ids = [...evaluation.deltas.keys()]
    .filter(
      (id) =>
        !verdicts.has(id) ||
        transitionsOf(id).every((transition) => transition === 'unverified' || transition === 'errored'),
    )
    .sort(compareCodePoints);
  const lines = [`### 4.5 Deltas the oracle could not verify (${ids.length})`, ''];

  for (const id of ids.slice(0, limits.cap)) {
    let why = 'unverified';

    if (!verdicts.has(id)) {
      why = 'not run';
    } else if (transitionsOf(id).includes('errored')) {
      why = 'errored';
    }

    const entry = evaluation.cases.get(id) ?? /** @type {Record<string, never>} */ ({});

    lines.push(
      `- \`${id}\` (${why}) ${describeCase(entry)} ${EM_DASH} ${classificationText(classificationOf(evaluation, id))}`,
    );
  }

  if (ids.length > limits.cap) {
    lines.push(`- _${ids.length - limits.cap} more in corpus/deltas.jsonl_`);
  }

  lines.push('');

  return lines;
}

/**
 * 4.6: cases the browsers cannot judge against base, outputs base already gives for other targets,
 * and cases classified NEEDS_MAINTAINER_DECISION.
 *
 * @param {DeltaView} view
 * @returns {string[]}
 */
function decisionGroup(view) {
  const { evaluation, limits } = view;
  const verdicts = verdictsOf(evaluation);
  const rejected = (/** @type {string} */ id) =>
    (verdicts.get(id) ?? []).some((verdict) => verdict.summary.latest.transition === 'input-rejected');
  const ids = new Set([
    ...[...verdicts.keys()].filter((id) => rejected(id) && evaluation.deltas.has(id)),
    ...evaluation.extended.keys(),
    ...[...evaluation.deltas.keys()].filter(
      (id) => classificationOf(evaluation, id)?.classification === 'NEEDS_MAINTAINER_DECISION',
    ),
  ]);
  const sorted = [...ids].sort(compareCodePoints);
  const lines = [
    `### 4.6 Decision needed (${sorted.length})`,
    '',
    'Cases the browsers cannot judge against base (input rejected in every engine), outputs base already produces for other targets, and cases classified NEEDS_MAINTAINER_DECISION.',
    '',
  ];

  for (const id of sorted.slice(0, limits.cap)) {
    let why = 'classified';

    if (evaluation.extended.has(id)) {
      why = `base test \`${evaluation.extended.get(id)}\` gives this output for other targets`;
    } else if (verdicts.has(id) && rejected(id)) {
      why = 'input rejected in every engine';
    }

    lines.push(`- \`${id}\` (${why}) ${EM_DASH} ${classificationText(classificationOf(evaluation, id))}`);
  }

  if (sorted.length > limits.cap) {
    lines.push(`- _${sorted.length - limits.cap} more_`);
  }

  lines.push('');

  return lines;
}

/**
 * 4.7: deltas classified PRE_EXISTING.
 *
 * @param {DeltaView} view
 * @returns {string[]}
 */
function preExistingGroup(view) {
  const { evaluation, limits } = view;
  const ids = [...evaluation.deltas.keys()]
    .filter((id) => classificationOf(evaluation, id)?.classification === 'PRE_EXISTING')
    .sort(compareCodePoints);
  const lines = [`### 4.7 Pre-existing (base wrong the same way) (${ids.length})`, ''];

  for (const id of ids.slice(0, limits.cap)) {
    lines.push(`- \`${id}\` ${EM_DASH} ${pyStr(classificationOf(evaluation, id)?.reason)}`);
  }

  if (ids.length > limits.cap) {
    lines.push(`- _${ids.length - limits.cap} more_`);
  }

  lines.push('');

  return lines;
}
