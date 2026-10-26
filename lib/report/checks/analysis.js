/**
 * Analysis checks A1 (spec checklist answers) and A2 (linked issues reproduced by a PR probe), and
 * the evidence rules every FAIL / FAIL_PRE_EXISTING answer must meet (reported by A3).
 *
 * Stage: report. Reads the run's checklist, the reviewer's answers in analysis.json, the probe
 * assertion results, the oracle verdicts and (for base tuples cited as evidence) the base outputs.
 *
 * A reviewer may lower an item's severity with `effective_severity` and a `severity_reason`, never
 * raise it. A FAIL_PRE_EXISTING answer is a note, and only with evidence that base fails the same
 * way.
 */
import { matchesExpectation } from '../../build/tuples.js';
import { pyGet } from '../../core/py-value.js';
import { compareCodePoints, pyStr, pyTruthy } from '../../core/py.js';
import { caseRefs, light } from '../cases.js';
import { ANSWERS, ISSUE_REF, isSeverity, PRE_EVIDENCE, SEV_RANK, WORD_CHAR } from '../constants.js';

/**
 * @import { ProbeResult, Severity } from '../../types.js'
 * @import { ChecklistItem, ResolvedAnswer } from '../checklists.js'
 * @import { EvalContext } from '../context.js'
 * @import { ProbeAsserts } from './probes.js'
 */

/**
 * @typedef {object} FailedItem A checklist item answered FAIL.
 * @property {ChecklistItem} item
 * @property {ResolvedAnswer} answer
 * @property {Severity} severity The effective severity.
 */

/**
 * @typedef {object} PreExistingItem A checklist item answered FAIL_PRE_EXISTING.
 * @property {ChecklistItem} item
 * @property {ResolvedAnswer} answer
 */

/**
 * @typedef {object} ChecklistReview
 * @property {FailedItem[]} failed
 * @property {PreExistingItem[]} preExisting
 * @property {string[]} missing Items without a valid answer or without evidence.
 * @property {string[]} problems Answers that break an evidence rule (A3 lists them).
 */

/** Transitions of a cited probe that its own verify line accepts (a FAIL citing it contradicts itself). */
const ACCEPTED_TRANSITIONS = Object.freeze(['fixed', 'both-equivalent']);

/** Transitions that show base wrong on its own. */
const BASE_WRONG_TRANSITIONS = Object.freeze(['still-different', 'fixed', 'worsened']);

const OR_WORD = new RegExp(`(?<!${WORD_CHAR})or(?!${WORD_CHAR})`, 'u');

/**
 * A test for "base itself is wrong on this case": a probe assertion fails on base, the oracle finds
 * base different, a base tuple's base output matches the expectation base's own tests record, or
 * the case crashes on base.
 *
 * @param {EvalContext} ctx
 * @param {Map<string, ProbeAsserts>} probeAsserts
 * @param {Set<string>} baseCrashes
 * @returns {(id: string) => boolean}
 */
export function baseWrongTest(ctx, probeAsserts, baseCrashes) {
  return (id) => {
    const asserts = probeAsserts.get(id);

    if (asserts && [...asserts.base.values()].some((result) => result === false)) {
      return true;
    }

    const verdict = light(ctx.verdicts.get(id));

    if (
      verdict &&
      (verdict.summary.latest.base === 'different' ||
        BASE_WRONG_TRANSITIONS.includes(verdict.summary.latest.transition))
    ) {
      return true;
    }

    const entry = ctx.caseOf(id);
    const expectation = entry.expectation;

    if (
      entry.source === 'tuple' &&
      (entry.side === 'base' || entry.side === 'both') &&
      expectation !== undefined &&
      pyTruthy(expectation)
    ) {
      const output = ctx.outputs('base').get(id);

      return output !== undefined && pyTruthy(output) && matchesExpectation(expectation, output) === true;
    }

    return baseCrashes.has(id);
  };
}

/**
 * Review the checklist answers and evaluate A1.
 *
 * @param {EvalContext} ctx
 * @param {(id: string) => boolean} baseWrong
 * @returns {ChecklistReview}
 */
export function checklistCheck(ctx, baseWrong) {
  /** @type {ChecklistReview} */
  const review = { failed: [], preExisting: [], missing: missingItems(ctx), problems: [] };

  for (const item of ctx.checklist) {
    const answer = ctx.answers.get(item.item) || /** @type {ResolvedAnswer} */ ({});

    if (answer.answer === 'FAIL') {
      review.failed.push({ item, answer, severity: itemSeverity(item, answer, review.problems) });
    } else if (answer.answer === 'FAIL_PRE_EXISTING') {
      review.preExisting.push({ item, answer });
    } else if (pyTruthy(answer.effective_severity)) {
      itemSeverity(item, answer, review.problems);
    }
  }

  for (const failed of review.failed) {
    review.problems.push(...failProblems(ctx, failed));
  }

  for (const { item, answer } of review.preExisting) {
    const text = answerText(answer);

    if (!ISSUE_REF.test(text) && !caseRefs(text, ctx.known).some(baseWrong)) {
      review.problems.push(
        `${item.item}: FAIL_PRE_EXISTING needs evidence that base fails the same way: ${PRE_EVIDENCE}`,
      );
    }
  }

  addA1(ctx, review);

  return review;
}

/**
 * @param {EvalContext} ctx
 * @returns {string[]}
 */
function missingItems(ctx) {
  return ctx.checklist
    .filter((item) => {
      const answer = ctx.answers.get(item.item);

      return !ANSWERS.includes(/** @type {string} */ (answer?.answer)) || !pyTruthy(answer?.evidence);
    })
    .map((item) => item.item);
}

/**
 * `<evidence> <note>`, the free text an answer cites cases in.
 *
 * @param {ResolvedAnswer} answer
 * @returns {string}
 */
export function answerText(answer) {
  return `${pyStr(pyGet(answer, 'evidence', ''))} ${pyStr(pyGet(answer, 'note', ''))}`;
}

/**
 * The severity an answered item counts with: its own, or a valid lower `effective_severity`.
 * Invalid overrides are reported as problems and ignored.
 *
 * @param {ChecklistItem} item
 * @param {ResolvedAnswer} answer
 * @param {string[]} problems
 * @returns {Severity}
 */
function itemSeverity(item, answer, problems) {
  const effective = answer.effective_severity;

  if (!pyTruthy(effective)) {
    return item.severity;
  }

  if (!isSeverity(effective)) {
    problems.push(`${item.item}: effective_severity ${pyStr(effective)} is not a severity`);
  } else if (SEV_RANK[effective] < SEV_RANK[item.severity]) {
    problems.push(`${item.item}: effective_severity cannot raise ${item.severity} to ${effective}`);
  } else if (!pyTruthy(answer.severity_reason)) {
    problems.push(`${item.item}: effective_severity ${effective} needs a severity_reason`);
  } else {
    return effective;
  }

  return item.severity;
}

/**
 * Problems of a FAIL answer: it cites a probe of a mode its verify line names whose transition that
 * line accepts, or its verify line offers alternatives (`or`) and no note says why none holds.
 *
 * @param {EvalContext} ctx
 * @param {FailedItem} failed
 * @returns {string[]}
 */
function failProblems(ctx, failed) {
  const { item, answer } = failed;
  const verify = pyGet(item, 'verify', '');
  const problems = [];

  for (const ref of caseRefs(answerText(answer), ctx.known)) {
    const mode = pyGet(ctx.caseOf(ref).probe || {}, 'mode', null);

    if (!pyTruthy(mode) || !mentionsWord(verify, String(mode))) {
      continue;
    }

    const verdict = light(ctx.verdicts.get(ref));
    const transition = verdict ? verdict.summary.latest.transition : null;

    if (transition !== null && ACCEPTED_TRANSITIONS.includes(transition)) {
      problems.push(
        `${item.item}: FAIL cites ${ref} (${pyStr(mode)}, ${transition}), which its verify line accepts`,
      );
    }
  }

  if (OR_WORD.test(verify) && !pyTruthy(answer.note)) {
    problems.push(`${item.item}: a FAIL must say in \`note\` why each verify alternative does not hold`);
  }

  return problems;
}

/**
 * Whether `word` appears in `text` as a whole word (hyphens count as word characters, so `lower`
 * does not match inside `lower-minify`).
 *
 * @param {string} text
 * @param {string} word
 * @returns {boolean}
 */
function mentionsWord(text, word) {
  const boundary = String.raw`[\p{L}\p{N}_-]`;

  return new RegExp(`(?<!${boundary})${RegExp.escape(word)}(?!${boundary})`, 'u').test(text);
}

/**
 * A1: the checklist row. Failed items are reported by their own findings, so the row never becomes
 * one; it takes the worst effective severity.
 *
 * @param {EvalContext} ctx
 * @param {ChecklistReview} review
 * @returns {void}
 */
function addA1(ctx, review) {
  const { failed, preExisting, missing } = review;
  const preNote = preExisting.length > 0 ? `; ${preExisting.length} fail on base too (notes)` : '';

  if (!pyTruthy(ctx.analysis)) {
    ctx.checks.add('A1', 'SKIP', 'analysis.json missing');
  } else if (failed.length > 0) {
    const ordered = [...failed].sort(
      (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || compareCodePoints(a.item.item, b.item.item),
    );
    const summary = ordered.map(({ item, severity }) => `${item.item} (${severity})`).join(', ');

    ctx.checks.add(
      'A1',
      'FAIL',
      `${failed.length} checklist item(s) failed: ${summary}${preNote}`,
      ordered.map(({ item, severity }) => `${item.item} (${severity}): ${item.text}`),
      { severity: ordered[0].severity, finding: false },
    );
  } else {
    const total = ctx.checklist.length;

    ctx.checks.add(
      'A1',
      missing.length === 0 ? 'PASS' : 'PARTIAL',
      `${total - missing.length}/${total} items answered${preNote}`,
      [],
      { severity: 'NOTE' },
    );
  }
}

/**
 * A2: every linked issue the PR claims to close is reproduced by a PR probe (`repro: #N`) that
 * fails on base and passes on head. Closed or merely related issues are context, not a promise of
 * this PR: their problems are notes.
 *
 * @param {EvalContext} ctx
 * @param {Map<string, ProbeAsserts>} probeAsserts
 * @param {string[]} probeFixed
 * @returns {void}
 */
export function linkedIssueCheck(ctx, probeAsserts, probeFixed) {
  const linked = pyGet(ctx.prep, 'linked_issues', []);

  if (linked.length > 0 && !pyTruthy(ctx.analysis)) {
    ctx.checks.add('A2', 'SKIP', 'analysis.json missing (write an issue probe first)');

    return;
  }

  if (linked.length === 0) {
    ctx.checks.add('A2', 'SKIP', 'no linked issues');

    return;
  }

  const outcome = reviewIssues(ctx, linked, probeAsserts);
  const fixed = probeFixed.length > 0 ? `${probeFixed.length} probe assertion(s) fixed by this PR` : '';
  // The problems lead the evidence; probe credit is context and only summarized.
  const creditNote = fixed ? `; ${fixed} (T6)` : '';
  const issues = `${linked.length} linked issue(s)`;

  if (outcome.hard.length > 0) {
    ctx.checks.add('A2', 'FAIL', issues + creditNote, [...outcome.hard, ...outcome.soft, ...outcome.unknown]);
  } else if (outcome.unknown.length > 0) {
    ctx.checks.add('A2', 'INCONCLUSIVE', `${issues}; the oracle could not run on the repro${creditNote}`, [
      ...outcome.unknown,
      ...outcome.soft,
    ]);
  } else if (outcome.soft.length > 0) {
    ctx.checks.add(
      'A2',
      'PARTIAL',
      `${issues}; closed or related ones need no repro${creditNote}`,
      outcome.soft,
      {
        severity: 'NOTE',
      },
    );
  } else {
    ctx.checks.add(
      'A2',
      'PASS',
      issues + (fixed ? `; ${fixed}` : ''),
      probeFixed.map((entry) => `fixed by this PR: ${entry}`),
    );
  }
}

/**
 * @typedef {object} IssueOutcome
 * @property {string[]} hard Problems with issues the PR closes.
 * @property {string[]} soft Problems with closed or related issues.
 * @property {string[]} unknown Repro probes the oracle could not judge.
 */

/**
 * @param {EvalContext} ctx
 * @param {import('../../types.js').LinkedIssue[]} linked
 * @param {Map<string, ProbeAsserts>} probeAsserts
 * @returns {IssueOutcome}
 */
function reviewIssues(ctx, linked, probeAsserts) {
  /** @type {IssueOutcome} */
  const outcome = { hard: [], soft: [], unknown: [] };
  const probes = new Map(pyGet(ctx.corpus, 'probes', []).map((probe) => [probe.id, probe]));
  const prProbes = [...probes.values()].filter((probe) => probe.origin === 'pr');

  for (const issue of linked) {
    const number = issue.number;
    const lenient = pyStr(pyGet(issue, 'state', '')).toUpperCase() === 'CLOSED' || issue.closing === false;
    const sink = lenient ? outcome.soft : outcome.hard;
    let repros = prProbes.filter((probe) => reproOf(ctx, probe) === number);

    if (repros.length === 0) {
      repros = prProbes.filter((probe) => probe.known === `open-issue#${pyStr(number)}`);
    }

    if (repros.length === 0) {
      sink.push(`#${pyStr(number)}: no PR probe with \`repro: #${pyStr(number)}\``);
      continue;
    }

    for (const probe of repros.sort((a, b) => compareCodePoints(a.id, b.id))) {
      reviewRepro(ctx, probe, /** @type {ProbeAsserts} */ (probeAsserts.get(probe.id)), {
        label: `#${pyStr(number)}: ${pyStr(probe.probe)}`,
        sink,
        unknown: outcome.unknown,
      });
    }
  }

  return outcome;
}

/**
 * The issue number a probe reproduces (its `repro:` header), or null.
 *
 * @param {EvalContext} ctx
 * @param {ProbeResult} probe
 * @returns {number | null}
 */
function reproOf(ctx, probe) {
  const repro = pyTruthy(probe.repro) ? probe.repro : pyGet(ctx.caseOf(probe.id).probe || {}, 'repro', null);
  // The corpus stage stores `repro` as an int, so its digits are ASCII.
  const match = /\d+/.exec(pyTruthy(repro) ? pyStr(repro) : '');

  return match ? Number(match[0]) : null;
}

/**
 * Judge one repro probe: it must pass on head, and fail on base unless the probe changed.
 *
 * @param {EvalContext} ctx
 * @param {ProbeResult} probe
 * @param {ProbeAsserts} asserts
 * @param {{ label: string, sink: string[], unknown: string[] }} target
 * @returns {void}
 */
function reviewRepro(ctx, probe, asserts, target) {
  const { label, sink, unknown } = target;
  const usesEquivalent = asserts.head.has('equivalent');
  const plain = (/** @type {Map<string, boolean | null>} */ results) =>
    [...results]
      .filter(([name, result]) => name !== 'equivalent' && result !== null)
      .map(([, result]) => result);
  const plainHead = plain(asserts.head);
  const plainBase = plain(asserts.base);

  if (usesEquivalent && asserts.head.get('equivalent') === null) {
    const verdict = light(ctx.verdicts.get(probe.id));

    unknown.push(
      `${label}: the oracle could not judge it (${verdict ? verdict.summary.latest.transition : 'not run'})`,
    );

    if (plainHead.length === 0) {
      return;
    }
  }

  const headOk = plainHead.every(pyTruthy) && (!usesEquivalent || asserts.head.get('equivalent') !== false);
  const baseOk = plainBase.every(pyTruthy) && (!usesEquivalent || asserts.base.get('equivalent') !== false);

  if (!headOk) {
    sink.push(`${label} fails on head`);
  } else if (baseOk && !pyTruthy(probe.changed)) {
    sink.push(`${label} passes on base too (does it reproduce the issue?)`);
  }
}
