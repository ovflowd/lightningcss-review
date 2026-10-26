/**
 * Render report.md from an evaluation.
 *
 * Stage: report. Besides the evaluation it reads config/checks.json (thresholds),
 * corpus/outputs-*.jsonl (case blocks), spec-cards.json and <cache>/baseline.json.
 *
 * Invariant: the same run always renders the same bytes, in the layout of earlier reports (the
 * report format is a contract: reviewers diff reports between runs). Every interpolated value goes
 * through `pyStr`, lengths and cuts count code points, and every list is sorted by code point.
 *
 * Sections: header, 1 checks, 2 findings, 3 change, 4 behavioral delta (render-delta.js),
 * 5 test expectations, 6 spec checklist, 7 robustness, 8 real-world corpus, 9 master baseline,
 * 10 coverage and limits, appendix A spec cards, reproduce.
 */
import { join } from 'node:path';

import { readJson } from '../core/files.js';
import { joinPath } from '../core/pathlib.js';
import { cacheDir, loadConfig, skillVersion } from '../core/paths.js';
import { pyGet, pyList } from '../core/py-value.js';
import { compareCodePoints, pyFormat, pySlice, pySorted, pyStr, pyTruthy } from '../core/py.js';
import { dumps } from '../core/pyjson.js';
import { isSeverity, LISTED_ENGINES, SEV_RANK } from './constants.js';
import { ARROW, CHECK_MARK, CROSS_MARK, DELTA, EM_DASH, MIDDLE_DOT, SECTION } from './glyphs.js';
import { renderDelta } from './render-delta.js';
import { fence, mdCell, snippet } from './text.js';
import { verdictLine } from './verdict.js';

/**
 * @import { Baseline, ChecksConfig, EngineVersions, PrMeta, SpecCard } from '../types.js'
 * @import { Evaluation } from './evaluate.js'
 */

/**
 * @typedef {object} RenderLimits
 * @property {number} snippet Characters of input/output shown per case.
 * @property {number} cap Cases listed per section before `N more`.
 */

/** Short commit ids in the header. */
const SHORT_SHA = 12;

/** Evidence characters in the check table; checklist text and evidence in the checklist table. */
const CHECK_EVIDENCE_CHARS = 160;
const CHECKLIST_CELL_CHARS = 140;

/** Folded entry titles in a finding. */
const FOLDED_TITLE_CHARS = 200;

/** Rows listed per tuple bucket, crashes and idempotency lists. */
const MAX_LISTED_ROWS = 6;

/** Characters of a crash message in section 7. */
const CRASH_ERROR_CHARS = 160;

/** Characters per spec-card cell in appendix A. */
const CARD_SYNTAX_CHARS = 160;
const CARD_INITIAL_CHARS = 60;
const CARD_COMPUTED_CHARS = 90;
const CARD_ANIMATION_CHARS = 40;

/** Overlapping PRs and files of a blast-radius name listed. */
const MAX_OVERLAPS = 8;
const MAX_RADIUS_FILES = 8;

/** Section 5's tuple buckets (corpus.json `tuples` keys) and their labels. */
const TUPLE_BUCKETS = /** @type {const} */ ([
  ['new_failing_on_base', 'New cases that fail on base (exercise the change)'],
  ['new_passing_on_base', 'New cases that already pass on base'],
  ['modified', 'Changed expectations'],
  ['removed_changed', 'Removed cases whose behavior changed'],
  ['removed_same', 'Removed cases, behavior unchanged'],
  ['head_mismatch', 'Not reproduced by the adapter (excluded)'],
]);

/** How prepare.json's `strategy` built the head tree, as the header names it. */
const STRATEGIES = new Map([
  ['merged-into-master', 'PR head merged into master (merge-tree, no commit)'],
  ['pr-head-vs-merge-base', 'PR head vs merge-base (merge conflicts with master)'],
  ['local-range', 'local range'],
]);

/**
 * report.md for an evaluated run (no trailing newline, as in every earlier report).
 *
 * @param {Evaluation} evaluation
 * @param {string} runDir
 * @returns {string}
 */
export function render(evaluation, runDir) {
  const thresholds = /** @type {ChecksConfig} */ (loadConfig('checks.json')).thresholds;
  /** @type {RenderLimits} */
  const limits = { snippet: thresholds.snippet_chars, cap: thresholds.max_listed_cases };
  const lines = [
    ...header(evaluation),
    ...checksSection(evaluation),
    ...findingsSection(evaluation),
    ...changeSection(evaluation),
    ...renderDelta(evaluation, runDir, limits),
    ...expectationsSection(evaluation),
    ...checklistSection(evaluation),
    ...robustnessSection(evaluation),
    ...realworldSection(evaluation),
    ...baselineSection(evaluation, limits),
    ...coverageSection(evaluation),
    ...specCardsSection(runDir),
    ...reproduceSection(evaluation),
  ];

  return lines.join('\n');
}

/**
 * `chromium 1 · firefox 2 · …` per profile, `latest` first; shared with the chat summary.
 *
 * @param {Record<string, EngineVersions>} profiles
 * @param {string} separator Between profiles.
 * @returns {string}
 */
export function engineList(profiles, separator) {
  const ordered = pySorted(Object.entries(profiles), ([name]) => name !== 'latest');

  return ordered
    .map(([name, versions]) => {
      const engines = Object.entries(versions)
        .filter(([engine]) => LISTED_ENGINES.includes(engine))
        .sort(([a], [b]) => compareCodePoints(a, b))
        .map(([engine, version]) => `${engine} ${pyStr(version)}`);

      return `${name}: ${engines.join(', ')}`;
    })
    .join(separator);
}

/**
 * @param {Evaluation} evaluation
 * @returns {Partial<PrMeta>}
 */
function prOf(evaluation) {
  return pyGet(evaluation.prep, 'pr', /** @type {Partial<PrMeta>} */ ({})) ?? {};
}

/**
 * Title, verdict line and the run facts.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function header(evaluation) {
  const { prep, counts } = evaluation;
  const pr = prOf(evaluation);
  const title = pyTruthy(pr)
    ? `#${pyStr(pr.number ?? null)} ${pyStr(pr.title ?? null)}`
    : pyStr(pyGet(prep, 'range', ''));
  const dot = ` ${MIDDLE_DOT} `;
  const lines = [
    `# LightningCSS review: ${title}`,
    '',
    `**VERDICT: ${verdictLine(evaluation.verdict, evaluation.scope)}**${dot}${counts.BLOCKER} blocker${dot}${counts.MAJOR} major${dot}${counts.MINOR} minor${dot}${counts.NOTE} note`,
    '',
  ];

  if (evaluation.scope) {
    lines.push(
      `- Every delta needs ${evaluation.scope.text.replaceAll(' only', '')}: the default path is byte-identical (${evaluation.scope.default_requests} requests)`,
    );
  }

  lines.push(...evaluation.decision.map((line) => `- Decision needed: ${line}`));

  const strategy = STRATEGIES.get(prep.strategy);

  if (strategy === undefined) {
    throw new Error(`unknown strategy in prepare.json: ${pyStr(prep.strategy)}`);
  }

  lines.push(`- Run \`${prep.run_id}\`${dot}skill ${skillVersion()}${dot}${strategy}`);
  lines.push(
    `- Base \`${pySlice(prep.base, 0, SHORT_SHA)}\`${dot}head tree \`${pySlice(prep.head_tree, 0, SHORT_SHA)}\`${dot}PR head \`${pySlice(pyGet(prep, 'pr_head', ''), 0, SHORT_SHA)}\``,
  );

  if (pyTruthy(pr)) {
    const draft = pyTruthy(pr.draft) ? ' (draft)' : '';

    lines.push(
      `- Author @${pyStr(pr.author ?? null)}${dot}${pyStr(pr.url ?? null)}${dot}state ${pyStr(pr.state ?? null)}${draft}`,
    );
  }

  const profiles = pyGet(evaluation.oracle, 'profiles', {});

  if (pyTruthy(profiles)) {
    lines.push(`- Engines: ${engineList(profiles, dot)}`);
  }

  if (evaluation.missingStages.length > 0) {
    lines.push(`- Stages not run: ${evaluation.missingStages.join(', ')}`);
  }

  lines.push('');

  return lines;
}

/**
 * Section 1: one table row per catalog check.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function checksSection(evaluation) {
  return [
    '## 1. Checks',
    '',
    '| ID | Check | Result | Severity | Evidence |',
    '|---|---|---|---|---|',
    ...evaluation.checks.map(
      (check) =>
        `| ${check.id} | ${mdCell(check.title)} | ${check.status} | ${check.severity || ''} | ${mdCell(snippet(check.evidence, CHECK_EVIDENCE_CHARS))} |`,
    ),
    '',
  ];
}

/**
 * Section 2: the findings with their evidence, folded entries, related findings and suggested test.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function findingsSection(evaluation) {
  const lines = ['## 2. Findings', ''];

  if (evaluation.findings.length === 0) {
    lines.push('None.');
  }

  for (const finding of evaluation.findings) {
    const tag = pyTruthy(finding.check) ? `[${finding.check}] ` : '';
    const origin = finding.source === 'analysis' ? ` (analysis ${finding.id})` : '';

    lines.push(`### F${finding.n} [${finding.severity}] ${tag}${pyStr(finding.title)}${origin}`, '');

    if (pyTruthy(finding.detail)) {
      lines.push(pyStr(finding.detail), '');
    }

    lines.push(...(finding.evidence || []).map((item) => `- ${pyStr(item)}`));

    if (pyTruthy(finding.folded)) {
      lines.push('', 'Also reported by:', '');
      lines.push(
        ...(finding.folded ?? []).map(
          (entry) =>
            `- [${entry.check || entry.source}] (${entry.severity}) ${snippet(entry.title, FOLDED_TITLE_CHARS)}`,
        ),
      );
    }

    if (pyTruthy(finding.related)) {
      lines.push('', `See also: ${(finding.related ?? []).join('; ')}`);
    }

    if (pyTruthy(finding.suggested_test)) {
      lines.push('', 'Suggested test:', '', fence(finding.suggested_test, 'rust'));
    }

    lines.push('');
  }

  return lines;
}

/**
 * Section 3: the reviewer's intent and the change classification from prepare.json.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function changeSection(evaluation) {
  const { prep } = evaluation;
  const lines = ['## 3. Change', ''];
  const intent = pyGet(
    evaluation.analysis,
    'intent',
    /** @type {Partial<import('../types.js').Analysis['intent']>} */ ({}),
  );

  if (pyTruthy(intent)) {
    lines.push(
      `- Kind: ${pyStr(intent.kind ?? null)} ${MIDDLE_DOT} behind flag: ${pyStr(pyGet(intent, 'behind_flag', 'n/a'))}`,
    );
    lines.push(`- Intent: ${pyStr(intent.summary ?? null)}`);
    lines.push(...pyList(pyGet(intent, 'claims', [])).map((claim) => `  - claim: ${pyStr(claim)}`));
  }

  const listOr = (/** @type {string[]} */ items) => items.join(', ') || 'none';

  lines.push(
    `- Areas: ${listOr(pyGet(prep, 'areas', []))} ${MIDDLE_DOT} from tests: ${listOr(pyGet(prep, 'test_areas', []))} ${MIDDLE_DOT} blast radius adds: ${listOr(pyGet(prep, 'radius_areas', []))}`,
  );
  lines.push(...fileLines(evaluation), ...itemLines(evaluation));

  for (const flag of pyGet(prep, 'risk_flags', [])) {
    lines.push(`- Risk flag \`${pyStr(flag.id)}\`: ${pyStr(flag.detail)}`);
  }

  for (const issue of pyGet(prep, 'linked_issues', [])) {
    lines.push(`- Linked issue #${pyStr(issue.number)} (${pyStr(issue.state)}): ${pyStr(issue.title)}`);
  }

  for (const pr of pyGet(prep, 'overlapping_prs', []).slice(0, MAX_OVERLAPS)) {
    lines.push(
      `- Overlaps open PR #${pyStr(pr.number)} ${pyStr(pr.title)} ${EM_DASH} ${pr.shared_files.join(', ')}`,
    );
  }

  lines.push('');

  return lines;
}

/**
 * The changed files with their status, size and areas, and the touched test functions.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function fileLines(evaluation) {
  const { prep } = evaluation;
  const fileAreas = /** @type {Record<string, string[]>} */ (pyGet(prep, 'file_areas', {}));
  const isDict = fileAreas !== null && typeof fileAreas === 'object' && !Array.isArray(fileAreas);
  const files = Object.entries(pyGet(prep, 'files', {})).sort(([a], [b]) => compareCodePoints(a, b));
  const lines = files.map(([path, info]) => {
    const areas = isDict && Object.hasOwn(fileAreas, path) ? fileAreas[path] : [];

    return `  - \`${path}\` ${pyStr(info.status)} +${pyStr(info.added)}/-${pyStr(info.removed)} ${ARROW} ${areas.join(', ')}`;
  });

  if (pyTruthy(prep.changed_tests)) {
    const tests = new Set(Object.values(prep.changed_tests ?? {}).flat());

    lines.push(`- Test functions touched: ${[...tests].sort(compareCodePoints).join(', ')}`);
  }

  return lines;
}

/**
 * The changed Rust items and the blast radius of changed names.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function itemLines(evaluation) {
  const { prep } = evaluation;
  /** @type {Map<string, [string, unknown, unknown]>} */
  const unique = new Map();

  for (const changed of pyGet(prep, 'changed_items', [])) {
    const triple = /** @type {[string, unknown, unknown]} */ ([
      changed.file,
      (changed.impl || {}).type ?? null,
      (changed.item || {}).name ?? null,
    ]);

    unique.set(dumps(triple), triple);
  }

  const items = pySorted(unique.values(), (triple) => triple.map(pyStr));
  const lines = [];

  if (items.length > 0) {
    const named = items.map(
      ([file, type, name]) =>
        `\`${file}\`:${pyTruthy(type) ? pyStr(type) : '-'}::${pyTruthy(name) ? pyStr(name) : '-'}`,
    );

    lines.push(`- Changed items: ${named.join(', ')}`);
  }

  for (const radius of pyGet(prep, 'blast_radius', [])) {
    lines.push(
      `  - \`${pyStr(radius.name)}\` referenced in ${radius.files.length} file(s): ${radius.files.slice(0, MAX_RADIUS_FILES).join(', ')}`,
    );
  }

  return lines;
}

/**
 * Section 5: what happened to the recorded test expectations.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function expectationsSection(evaluation) {
  const { corpus } = evaluation;
  const tuples = /** @type {Record<string, import('../types.js').TupleEntry[]>} */ (
    pyGet(corpus, 'tuples', {})
  );
  const stats = /** @type {Partial<import('../types.js').CorpusSummary['tuple_stats']>} */ (
    pyGet(corpus, 'tuple_stats', {})
  );
  const changedHeads = new Set(pyGet(tuples, 'modified', []).map((entry) => entry.head_id ?? null));
  const lines = [
    '## 5. Test expectations',
    '',
    `Recorded helper calls: base ${pyStr(pyGet(stats, 'base_tuples', 0))}, head ${pyStr(pyGet(stats, 'head_tuples', 0))} (unmappable: ${pyStr(pyGet(stats, 'unmappable', 0))}).`,
    '',
  ];

  for (const [key, label] of TUPLE_BUCKETS) {
    const rows = pyGet(tuples, key, []).filter(
      (row) => key === 'modified' || !changedHeads.has(row.id ?? null),
    );

    lines.push(`- ${label}: ${rows.length}`);

    for (const row of rows.slice(0, MAX_LISTED_ROWS)) {
      const moved = pyTruthy(row.head_line) ? ` ${ARROW} lib.rs:${pyStr(row.head_line)}` : '';

      lines.push(`  - \`${testName(row.test)}\` lib.rs:${pyStr(row.line)}${moved}`);
    }
  }

  const unmappable = pyGet(stats, 'unmappable_cases', []).filter((entry) => pyTruthy(entry.in_diff));

  if (unmappable.length > 0) {
    lines.push(`- In the diff but not runnable through the adapter: ${unmappable.length}`);

    for (const entry of unmappable.slice(0, MAX_LISTED_ROWS)) {
      const why = pyTruthy(entry.reason) ? entry.reason : (entry.helper ?? null);

      lines.push(`  - \`${testName(entry.test)}\` lib.rs:${pyStr(entry.line ?? null)}: ${pyStr(why)}`);
    }
  }

  lines.push('');

  return lines;
}

/**
 * `tests::test_color` -> `test_color`
 *
 * @param {unknown} test
 * @returns {string}
 */
function testName(test) {
  return /** @type {string} */ (pyStr(test).split('::').at(-1));
}

/**
 * Section 6: the checklist with each answer. A valid lowered severity shows as `MAJOR → MINOR`.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function checklistSection(evaluation) {
  const lines = ['## 6. Spec checklist', ''];

  if (evaluation.checklist.length === 0) {
    lines.push('No checklist applies.', '');

    return lines;
  }

  lines.push('| Item | Severity | Check | Answer | Evidence |', '|---|---|---|---|---|');

  for (const item of evaluation.checklist) {
    const answer =
      evaluation.answers.get(item.item) ?? /** @type {import('./checklists.js').ResolvedAnswer} */ ({});
    const effective = answer.effective_severity;
    const lowered =
      pyTruthy(answer.severity_reason) &&
      isSeverity(effective) &&
      SEV_RANK[effective] > SEV_RANK[item.severity];
    const severity = item.severity + (lowered ? ` ${ARROW} ${effective}` : '');
    const value = pyTruthy(answer.answer) ? pyStr(answer.answer) : EM_DASH;
    const area = pyTruthy(answer.area_level) ? ' (area)' : '';

    lines.push(
      `| ${item.item} | ${severity} | ${mdCell(snippet(item.text, CHECKLIST_CELL_CHARS))} | ${value}${area} | ${mdCell(snippet(pyGet(answer, 'evidence', ''), CHECKLIST_CELL_CHARS))} |`,
    );
  }

  lines.push('');

  return lines;
}

/**
 * Section 7: crashes and idempotency.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function robustnessSection(evaluation) {
  const { corpus } = evaluation;
  const robustness = pyGet(
    corpus,
    'robustness',
    /** @type {Partial<import('../types.js').CorpusSummary['robustness']>} */ ({}),
  );
  const head = pyGet(robustness, 'head', []);
  const failures = pyGet(corpus, 'idempotency_failures', []);
  const lines = [
    '## 7. Robustness and stability',
    '',
    `- Panics/crashes/timeouts: head ${head.length}, base ${pyGet(robustness, 'base', []).length}`,
    ...head
      .slice(0, MAX_LISTED_ROWS)
      .map(
        (entry) =>
          `  - \`${pyStr(entry.id)}\` ${pyStr(entry.stage)}: ${snippet(entry.error, CRASH_ERROR_CHARS)}`,
      ),
    `- Not idempotent on head only (second minify pass changes output): ${failures.length}`,
    ...failures.slice(0, MAX_LISTED_ROWS).map((id) => `  - \`${id}\``),
  ];

  if (Object.hasOwn(corpus, 'idempotency_preexisting')) {
    const preExisting = corpus.idempotency_preexisting ?? [];

    lines.push(`- Not idempotent on base and head alike (pre-existing): ${preExisting.length}`);
    lines.push(...preExisting.slice(0, MAX_LISTED_ROWS).map((id) => `  - \`${id}\``));
  }

  lines.push('');

  return lines;
}

/**
 * Section 8: real-world output sizes.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function realworldSection(evaluation) {
  const size = pyGet(evaluation.corpus, 'size', []);

  if (!pyTruthy(size)) {
    return ['## 8. Real-world corpus', '', 'Not available (`lcr realworld`).', ''];
  }

  return [
    '## 8. Real-world corpus',
    '',
    `| File | Mode | Base bytes | Head bytes | ${DELTA} |`,
    '|---|---|---|---|---|',
    ...size.map(
      (row) =>
        `| ${pyStr(row.name)} | ${pyStr(row.mode)} | ${pyStr(row.base)} | ${pyStr(row.head)} | ${pyFormat(row.head - row.base, '+d')} |`,
    ),
    '',
  ];
}

/**
 * Section 9: curated probes that fail on master in the touched areas, so they are not mistaken for
 * the PR's doing.
 *
 * @param {Evaluation} evaluation
 * @param {RenderLimits} limits
 * @returns {string[]}
 */
function baselineSection(evaluation, limits) {
  const lines = ['## 9. Known failures in the touched areas (master baseline)', ''];
  // Printed below, so spelled as pathlib spells it: the section text stays the same between runs.
  const path = joinPath(cacheDir(), 'baseline.json');
  const baseline = /** @type {Baseline | null} */ (readJson(path));

  if (!baseline || !pyTruthy(baseline)) {
    lines.push(
      'No baseline yet (`lcr baseline`). Pre-existing failures are not attributed to the PR either way: only base' +
        `${ARROW}head transitions are.`,
      '',
    );

    return lines;
  }

  const touched = new Set(pyGet(evaluation.prep, 'areas', []));
  const rows = Object.entries(baseline.probes)
    .filter(([, probe]) => touched.has(probe.area) && pyTruthy(probe.fails_on_master))
    .sort(([a], [b]) => compareCodePoints(a, b));

  lines.push(
    `Master \`${pySlice(baseline.master, 0, SHORT_SHA)}\`: ${rows.length} curated probe(s) in the touched areas fail today. A PR that changes them shows up in ${SECTION}4; these are listed so they are not mistaken for the PR's doing.`,
    '',
  );
  lines.push(
    ...rows
      .slice(0, limits.cap)
      .map(([id, probe]) => `- \`${id}\` (${pyStr(probe.known)}): fails ${probe.fails_on_master.join(', ')}`),
  );

  if (rows.length > limits.cap) {
    lines.push(`- _${rows.length - limits.cap} more in ${path}_`);
  }

  lines.push('');

  return lines;
}

/**
 * Section 10: which stages ran, DOM synthesis coverage and what the oracle cannot prove.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function coverageSection(evaluation) {
  const stages = Object.entries(evaluation.stages).map(
    ([name, ran]) => `${name} ${ran ? CHECK_MARK : CROSS_MARK}`,
  );
  const lines = ['## 10. Coverage and limits', '', `- Stages: ${stages.join(', ')}`];
  const meta = Object.values(pyGet(evaluation.oracle, 'dom', {}));

  if (meta.length > 0) {
    const dom = (/** @type {import('../types.js').JobMeta} */ entry) =>
      pyGet(entry, 'dom', /** @type {Partial<NonNullable<import('../types.js').JobMeta['dom']>>} */ ({}));
    const generic = meta.filter((entry) => pyTruthy(dom(entry).generic)).length;
    const unsupported = meta.reduce((sum, entry) => sum + Number(pyGet(dom(entry), 'unsupported', 0)), 0);

    lines.push(
      `- DOM synthesis: ${meta.length} case(s), ${generic} fell back to the generic DOM, ${unsupported} selector component(s) not synthesizable (pseudo-states are rewritten to attributes)`,
    );
  }

  lines.push(
    '- The oracle proves equivalence only for the synthesized DOM and the engines listed above; Playwright WebKit is not Safari.',
    "- Legacy checks run only for engines inside a case's targets; older targets are covered by compat data, not execution.",
    '',
  );

  return lines;
}

/**
 * Appendix A: the webref spec cards of the touched properties, in priority order.
 *
 * @param {string} runDir
 * @returns {string[]}
 */
function specCardsSection(runDir) {
  const cards = specCards(runDir);

  if (cards.size === 0) {
    return [];
  }

  const lines = [
    '## Appendix A: spec cards for the touched properties (W3C webref)',
    '',
    '| Property | Syntax | Initial | Inherited | Computed value | Animation | Longhands |',
    '|---|---|---|---|---|---|---|',
  ];
  const missing = [...cards].filter(([, card]) => pyTruthy(card.missing)).map(([name]) => name);

  for (const [name, card] of cards) {
    if (!pyTruthy(card.missing)) {
      lines.push(specCardRow(name, card));
    }
  }

  if (missing.length > 0) {
    const names = missing.sort(compareCodePoints).map((name) => `\`${name}\``);

    lines.push('', `Not in any spec (legacy or vendor names handled by the same code): ${names.join(', ')}`);
  }

  lines.push('');

  return lines;
}

/**
 * spec-cards.json's cards in its `order` (or by name).
 *
 * @param {string} runDir
 * @returns {Map<string, SpecCard>}
 */
function specCards(runDir) {
  const file = readJson(join(runDir, 'spec-cards.json'));
  const spec = /** @type {Record<string, unknown>} */ (pyTruthy(file) ? file : {});
  const isDict = spec !== null && typeof spec === 'object' && !Array.isArray(spec);
  const all = /** @type {Record<string, SpecCard>} */ (isDict ? pyGet(spec, 'cards', spec) : {});
  const order = pyTruthy(spec.order)
    ? /** @type {string[]} */ (spec.order)
    : Object.keys(all).sort(compareCodePoints);
  /** @type {Map<string, SpecCard>} */
  const cards = new Map();

  for (const name of order) {
    if (Object.hasOwn(all, name) && !cards.has(name)) {
      cards.set(name, all[name]);
    }
  }

  return cards;
}

/**
 * @param {string} name
 * @param {SpecCard} card
 * @returns {string}
 */
function specCardRow(name, card) {
  const cell = (/** @type {unknown} */ value, /** @type {number} */ limit) =>
    mdCell(snippet(value ?? null, limit));
  const longhands = (card.longhands || []).join(', ');

  return (
    `| [\`${name}\`](${pyStr(card.href ?? null)}) | \`${cell(card.syntax, CARD_SYNTAX_CHARS)}\` | ` +
    `${cell(card.initial, CARD_INITIAL_CHARS)} | ${pyStr(card.inherited ?? null)} | ` +
    `${cell(card.computedValue, CARD_COMPUTED_CHARS)} | ${cell(card.animationType, CARD_ANIMATION_CHARS)} | ${longhands} |`
  );
}

/**
 * The commands that reproduce the run.
 *
 * @param {Evaluation} evaluation
 * @returns {string[]}
 */
function reproduceSection(evaluation) {
  const number = pyStr(pyGet(prOf(evaluation), 'number', '<pr>'));
  const runId = evaluation.prep.run_id;
  const steps = ['build', 'corpus', 'probe', 'oracle', 'worklist', 'report'].map(
    (step) => `lcr ${step} ${runId}`,
  );

  return ['## Reproduce', '', fence([`lcr prepare ${number}`, ...steps].join('\n'), 'sh'), ''];
}
