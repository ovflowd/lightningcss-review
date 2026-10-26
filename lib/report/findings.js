/**
 * Findings: one per defect. The reviewer's analysis findings lead; checklist failures,
 * REGRESSION / NEEDS_MAINTAINER_DECISION classifications and failed check rows that link a finding
 * id or cite the same cases fold into it as evidence (the finding takes the worst severity of what
 * folded), so the same defect is never counted twice.
 *
 * Stage: report. Pure function of the evaluated check rows, the checklist review and analysis.json.
 *
 * Order: severity, then source (analysis, checklist, classification, check), then check id and
 * title; findings are numbered in that order (`F1`, `F2`, …).
 */
import { pyGet, pyIncludes, pyList } from '../core/py-value.js';
import { compareCodePoints, pyCompare, pySorted, pyStr, pyStrip, pyTruthy } from '../core/py.js';
import { caseRefs } from './cases.js';
import { FOLDABLE_GROUPS, isSeverity, SEV_RANK, SEVERITIES, SOURCE_RANK } from './constants.js';
import { ARROW, ELLIPSIS } from './glyphs.js';
import { answerText } from './checks/analysis.js';
import { analysisFindingIds } from './checks/completeness.js';
import { snippetWords } from './text.js';

/**
 * @import { Finding, Severity } from '../types.js'
 * @import { EvalContext } from './context.js'
 * @import { ChecklistReview } from './checks/analysis.js'
 */

/** Characters of a classification's reason in a finding title and in a decision line. */
const TITLE_REASON_CHARS = 120;
const DECISION_REASON_CHARS = 160;

/**
 * A finding while it is assembled (report.json `findings[]` once numbered).
 *
 * @typedef {object} FindingEntry
 * @property {Finding['source']} source
 * @property {string} [id] Analysis findings only.
 * @property {string | null} check
 * @property {Severity} severity
 * @property {string} title
 * @property {unknown} [detail]
 * @property {unknown[]} evidence
 * @property {unknown} [suggested_test]
 * @property {FoldedEntry[]} [folded]
 * @property {string[]} [related]
 * @property {number} [n]
 */

/** @typedef {{ source: string, check: string | null, severity: Severity, title: string }} FoldedEntry */

/**
 * @typedef {object} FindingsResult
 * @property {FindingEntry[]} findings Sorted and numbered.
 * @property {string[]} decision The "decision needed" lines (classified decisions, unclassified O10).
 */

/**
 * Build the findings.
 *
 * @param {EvalContext} ctx
 * @param {{ review: ChecklistReview, coverage: string[][], oracleBad: Set<string> }} inputs
 * @returns {FindingsResult}
 */
export function buildFindings(ctx, inputs) {
  const folder = new Folder(ctx);

  placeChecklistFailures(folder, inputs.review);

  const decision = placeClassifications(folder, inputs.coverage, inputs.oracleBad);

  placeCheckFailures(folder);

  const o10 = ctx.checks.open.get('O10');

  if (o10 && o10.length > 0) {
    decision.push(`${o10.length} case(s) the browsers cannot judge against base are unclassified (O10)`);
  }

  return { findings: number([...folder.analysis, ...folder.standalone]), decision };
}

/**
 * Holds the analysis findings and folds other entries into them.
 */
class Folder {
  /** @param {EvalContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.cap = ctx.cap;
    this.analysis = analysisFindings(ctx);
    /** @type {Map<string, FindingEntry>} */
    this.byId = new Map(this.analysis.map((finding) => [/** @type {string} */ (finding.id), finding]));
    /** @type {Map<string, string>} Case id -> the first analysis finding citing it. */
    this.cited = new Map();
    /** @type {FindingEntry[]} */
    this.standalone = [];

    for (const finding of this.analysis) {
      for (const evidence of finding.evidence) {
        for (const ref of caseRefs(evidence, ctx.known)) {
          if (!this.cited.has(ref)) {
            this.cited.set(ref, /** @type {string} */ (finding.id));
          }
        }
      }
    }
  }

  /**
   * The analysis finding an entry folds into: the one it links, else the one citing its cases (all
   * of them when `requireAll`, else any).
   *
   * @param {unknown} link
   * @param {readonly string[]} refs
   * @param {boolean} requireAll
   * @returns {FindingEntry | null}
   */
  target(link, refs, requireAll) {
    if (pyTruthy(link) && this.byId.has(pyStr(link))) {
      return /** @type {FindingEntry} */ (this.byId.get(pyStr(link)));
    }

    const hits = refs.filter((ref) => this.cited.has(ref));

    if (refs.length > 0 && hits.length > 0 && (hits.length === refs.length || !requireAll)) {
      return /** @type {FindingEntry} */ (this.byId.get(/** @type {string} */ (this.cited.get(hits[0]))));
    }

    return null;
  }

  /**
   * Fold an entry into a finding: record it, take the worse severity, add its new evidence.
   *
   * @param {FindingEntry} target
   * @param {FindingEntry} entry
   * @returns {void}
   */
  fold(target, entry) {
    (target.folded ??= []).push({
      source: entry.source,
      check: entry.check ?? null,
      severity: entry.severity,
      title: entry.title,
    });

    if (SEV_RANK[entry.severity] < SEV_RANK[target.severity]) {
      target.severity = entry.severity;
    }

    const extra = (entry.evidence || []).filter(
      (item) => pyTruthy(item) && !pyIncludes(target.evidence, item),
    );

    target.evidence.push(...extra.slice(0, this.cap));
  }

  /**
   * Fold the entry where it belongs, or keep it as a finding of its own.
   *
   * @param {FindingEntry} entry
   * @param {unknown} link
   * @param {readonly string[]} refs
   * @param {boolean} requireAll
   * @returns {FindingEntry} Where the entry landed.
   */
  place(entry, link, refs, requireAll) {
    const target = this.target(link, refs, requireAll);

    if (target) {
      this.fold(target, entry);

      return target;
    }

    this.standalone.push(entry);

    return entry;
  }
}

/**
 * The analysis findings with a valid severity, as finding entries.
 *
 * @param {EvalContext} ctx
 * @returns {FindingEntry[]}
 */
function analysisFindings(ctx) {
  const findings = pyGet(ctx.analysis, 'findings', []);
  const ids = analysisFindingIds(findings);

  return findings.flatMap((finding, index) =>
    isSeverity(finding.severity)
      ? [
          {
            source: /** @type {const} */ ('analysis'),
            id: ids[index],
            check: null,
            severity: finding.severity,
            title: pyGet(finding, 'title', ''),
            detail: pyGet(finding, 'detail', ''),
            evidence: pyList(finding.evidence || []),
            suggested_test: finding.suggested_test ?? null,
            folded: [],
          },
        ]
      : [],
  );
}

/**
 * Checklist failures fold into the finding they link or whose cases they cite. An item marked
 * `same-root-as: <ID>` restates that item's defect: when both fail it folds into wherever the root
 * item's failure landed (roots are placed first). FAIL_PRE_EXISTING answers become notes.
 *
 * @param {Folder} folder
 * @param {ChecklistReview} review
 * @returns {void}
 */
function placeChecklistFailures(folder, review) {
  const { known } = folder.ctx;
  const failedIds = new Set(review.failed.map(({ item }) => item.item));
  /** @type {Map<string, FindingEntry>} */
  const landed = new Map();
  const ordered = pySorted(review.failed, ({ item }) =>
    failedIds.has(/** @type {string} */ (item.same_root_as)),
  );

  for (const { item, answer, severity } of ordered) {
    const lowered =
      severity === item.severity
        ? ''
        : ` (severity ${item.severity} ${ARROW} ${severity}: ${pyStr(answer.severity_reason ?? null)})`;
    /** @type {FindingEntry} */
    const entry = {
      source: 'checklist',
      check: item.item,
      severity,
      title: item.text,
      detail: pyStr(pyGet(answer, 'note', '')) + lowered,
      evidence: [pyGet(answer, 'evidence', '')],
      folded: [],
    };
    const root = item.same_root_as === undefined ? undefined : landed.get(item.same_root_as);

    if (root !== undefined && !pyTruthy(answer.finding)) {
      folder.fold(root, entry);
      landed.set(item.item, root);
    } else {
      landed.set(item.item, folder.place(entry, answer.finding, caseRefs(answerText(answer), known), false));
    }
  }

  for (const { item, answer } of review.preExisting) {
    /** @type {FindingEntry} */
    const entry = {
      source: 'checklist',
      check: item.item,
      severity: 'NOTE',
      title: `Pre-existing (base fails too): ${item.text}`,
      detail: pyGet(answer, 'note', ''),
      evidence: [pyGet(answer, 'evidence', '')],
    };

    folder.place(entry, answer.finding, caseRefs(answerText(answer), known), false);
  }
}

/**
 * @typedef {object} ClassificationGroup Entries with the same classification and reason.
 * @property {string} classification
 * @property {string} reason
 * @property {unknown[]} patterns
 * @property {string[]} cases
 * @property {unknown} finding The first finding an entry links.
 */

/**
 * REGRESSION and NEEDS_MAINTAINER_DECISION classifications become findings, one per distinct
 * reason. A regression is a BLOCKER. A policy question never makes the verdict UNSAFE: MAJOR when
 * the browsers show head worse than base, otherwise a note.
 *
 * @param {Folder} folder
 * @param {string[][]} coverage
 * @param {Set<string>} oracleBad
 * @returns {string[]} The decision lines.
 */
function placeClassifications(folder, coverage, oracleBad) {
  const { ctx, cap } = folder;
  const decision = [];
  const groups = pySorted(classificationGroups(ctx, coverage).values(), (group) => [
    group.classification !== 'REGRESSION',
    group.reason,
  ]);

  for (const { classification, reason, patterns, cases, finding } of groups) {
    const ordered = pySorted(cases, (id) => [ctx.checks.rank(id), id]);
    const named = patterns.filter(pyTruthy);
    let evidence = ordered.slice(0, cap);

    if (ordered.length > cap) {
      evidence.push(`${ELLIPSIS} ${ordered.length - cap} more`);
    }

    if (evidence.length === 0) {
      evidence = /** @type {string[]} */ (named);
    }

    const count = ordered.length || patterns.length;
    const detail = `${reason} (${count} case(s))`;
    const regression = classification === 'REGRESSION';
    /** @type {FindingEntry} */
    const entry = {
      source: 'classification',
      check: null,
      severity: regression ? 'BLOCKER' : decisionSeverity(ordered, oracleBad),
      title: `${regression ? 'Regression' : 'Decision needed'}: ${snippetWords(reason, TITLE_REASON_CHARS)}`,
      detail,
      evidence,
    };

    if (!regression) {
      decision.push(`${snippetWords(reason, DECISION_REASON_CHARS)} (${count} case(s))`);
    }

    const refs =
      ordered.length > 0
        ? ordered
        : patterns.filter((pattern) => ctx.known.has(/** @type {string} */ (pattern)));

    folder.place(entry, finding, /** @type {string[]} */ (refs), true);
  }

  return decision;
}

/**
 * @param {string[]} cases
 * @param {Set<string>} oracleBad
 * @returns {Severity}
 */
function decisionSeverity(cases, oracleBad) {
  return cases.some((id) => oracleBad.has(id)) ? 'MAJOR' : 'NOTE';
}

/**
 * Group the REGRESSION / NEEDS_MAINTAINER_DECISION entries by classification and stripped reason.
 *
 * @param {EvalContext} ctx
 * @param {string[][]} coverage
 * @returns {Map<string, ClassificationGroup>}
 */
function classificationGroups(ctx, coverage) {
  /** @type {Map<string, ClassificationGroup>} */
  const groups = new Map();

  for (const [index, entry] of pyGet(ctx.analysis, 'deltas', []).entries()) {
    const classification = entry.classification;

    if (
      (classification !== 'REGRESSION' && classification !== 'NEEDS_MAINTAINER_DECISION') ||
      !pyTruthy(entry.reason)
    ) {
      continue;
    }

    const reason = pyStrip(entry.reason);
    const key = `${classification}\n${reason}`;
    const group = groups.get(key) ?? { classification, reason, patterns: [], cases: [], finding: null };

    groups.set(key, group);
    group.patterns.push(pyGet(entry, 'id', ''));
    group.cases.push(...coverage[index].filter((id) => !group.cases.includes(id)));

    if (!pyTruthy(group.finding)) {
      group.finding = entry.finding ?? null;
    }
  }

  return groups;
}

/**
 * Failed and partial check rows with a severity become findings, unless they are rows only (A1,
 * checks whose cases are all classified REGRESSION). Case-level rows fold into the analysis
 * finding citing all their cases; the rest stay standalone and name related findings.
 *
 * @param {Folder} folder
 * @returns {void}
 */
function placeCheckFailures(folder) {
  const { ctx } = folder;
  const failTitles = new Map(ctx.config.checks.map((meta) => [meta.id, meta.fail_title || meta.title]));

  for (const row of ctx.checks.rows) {
    if (
      (row.status !== 'FAIL' && row.status !== 'PARTIAL') ||
      !row.severity ||
      ctx.checks.noFinding.has(row.id)
    ) {
      continue;
    }

    /** @type {string[]} */
    const refs = [];

    for (const item of ctx.checks.fullItems.get(row.id) ?? []) {
      refs.push(...caseRefs(item, ctx.known).filter((ref) => !refs.includes(ref)));
    }

    /** @type {FindingEntry} */
    const entry = {
      source: 'check',
      check: row.id,
      severity: row.severity,
      title: row.status === 'FAIL' ? /** @type {string} */ (failTitles.get(row.id)) : row.title,
      detail: row.evidence,
      evidence: row.items,
    };
    const target = FOLDABLE_GROUPS.includes(row.group) ? folder.target(null, refs, true) : null;

    if (target) {
      folder.fold(target, entry);
      continue;
    }

    const related = [
      ...new Set(refs.filter((ref) => folder.cited.has(ref)).map((ref) => folder.cited.get(ref))),
    ];

    if (related.length > 0) {
      entry.related = /** @type {string[]} */ (related)
        .sort(compareCodePoints)
        .map((id) => `${id}: ${pyStr(folder.byId.get(id)?.title)}`);
    }

    folder.standalone.push(entry);
  }
}

/**
 * Sort the findings and number them; an empty `folded` list is dropped.
 *
 * @param {FindingEntry[]} findings
 * @returns {FindingEntry[]}
 */
function number(findings) {
  const sorted = [...findings].sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      compareCodePoints(a.check || '', b.check || '') ||
      pyCompare(a.title, b.title),
  );

  for (const [index, finding] of sorted.entries()) {
    finding.n = index + 1;

    if (!pyTruthy(finding.folded)) {
      delete finding.folded;
    }
  }

  return sorted;
}

/**
 * Findings per severity, worst first.
 *
 * @param {readonly FindingEntry[]} findings
 * @returns {Record<Severity, number>}
 */
export function countFindings(findings) {
  return /** @type {Record<Severity, number>} */ (
    Object.fromEntries(
      SEVERITIES.map((severity) => [
        severity,
        findings.filter((finding) => finding.severity === severity).length,
      ]),
    )
  );
}
