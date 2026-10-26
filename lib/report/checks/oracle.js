/**
 * Oracle checks O1-O10: what the browsers say about base and head output, case by case.
 *
 * Stage: report. Reads oracle.json verdicts, corpus cases and deltas, outputs-*.jsonl (to recognize
 * pre-existing behavior extended to new targets) and the analysis classifications.
 *
 * Every case-level failure is a slot: any valid classification closes it. Cases classified
 * REGRESSION are reported once, by their finding, so the check keeps its FAIL row without a
 * finding of its own. Transitions that leave nothing to compare (`errored`, `input-rejected`) are
 * never "different": they make O8 inconclusive or go to the decision bucket (O10).
 */
import { pyGet } from '../../core/py-value.js';
import { compareCodePoints, pyLstrip, pyTruthy } from '../../core/py.js';
import { dumps } from '../../core/pyjson.js';
import { caseId, engineStatuses, rejectedCounts, wrongIn } from '../cases.js';
import { BAD_TRANSITIONS } from '../constants.js';

/**
 * @import { ProfileSummary } from '../../types.js'
 * @import { CaseRecord, VerdictRecord } from '../cases.js'
 * @import { EvalContext } from '../context.js'
 */

/**
 * @typedef {object} OracleBuckets Check items (`<case>[~dark][@profile] [annotation]`) by finding.
 * @property {string[]} regressed Head worse than base in current engines (O1).
 * @property {string[]} newBad New or changed tests and flag-only output rendering differently (O2).
 * @property {string[]} rejected Output an in-target engine rejects with no fallback (O3).
 * @property {string[]} legacyRegressed Lowering regressions in legacy engines (O4).
 * @property {string[]} near Drift within tolerance (O5).
 * @property {string[]} visual Different pixels (O6).
 * @property {string[]} wptRegressed WPT regressions (O7).
 * @property {string[]} unverified Deltas no engine could judge (O8).
 * @property {string[]} errored Deltas whose engine job errored (O8).
 * @property {number} erroredTotal Errored jobs, deltas or not.
 * @property {string[]} divergent Engines read the input differently (O9).
 * @property {string[]} inputRejected Every engine rejects the input (O10).
 * @property {string[]} extended Head output base already gives for other targets (O10).
 * @property {string[]} outsideTargets Different only in engines outside the case's targets.
 * @property {string[]} screenshotErrors Cases without a screenshot comparison.
 * @property {Map<string, string>} extendedBy Case id -> the base test that already gives its output.
 */

/**
 * @typedef {object} BadCandidate A case head made worse, before checking for extended behavior.
 * @property {string} tag The check item.
 * @property {string} id
 * @property {string} source
 */

/**
 * The profiles of a verdict's legacy summary, in sorted order.
 *
 * @param {Record<string, ProfileSummary>} record
 * @returns {[string, ProfileSummary][]}
 */
function sortedEntries(record) {
  return Object.entries(record).sort(([a], [b]) => compareCodePoints(a, b));
}

/**
 * Sort every verdict into the buckets the oracle checks list.
 *
 * @param {EvalContext} ctx
 * @returns {OracleBuckets}
 */
export function oracleBuckets(ctx) {
  /** @type {OracleBuckets} */
  const buckets = {
    regressed: [],
    newBad: [],
    rejected: [],
    legacyRegressed: [],
    near: [],
    visual: [],
    wptRegressed: [],
    unverified: [],
    errored: [],
    erroredTotal: 0,
    divergent: [],
    inputRejected: [],
    extended: [],
    outsideTargets: [],
    screenshotErrors: [],
    extendedBy: new Map(),
  };
  /** @type {BadCandidate[]} */
  const candidates = [];

  for (const [id, verdicts] of [...ctx.verdicts].sort(([a], [b]) => compareCodePoints(a, b))) {
    for (const verdict of verdicts) {
      sortVerdict(ctx, id, verdict, buckets, candidates);
    }
  }

  splitCandidates(ctx, candidates, buckets);

  return buckets;
}

/**
 * @param {EvalContext} ctx
 * @param {string} id
 * @param {VerdictRecord} verdict
 * @param {OracleBuckets} buckets
 * @param {BadCandidate[]} candidates
 * @returns {void}
 */
function sortVerdict(ctx, id, verdict, buckets, candidates) {
  const entry = ctx.caseOf(id);
  const source = String(pyGet(entry, 'source', '?'));
  const headTuple = source === 'tuple' && entry.side === 'head';
  const summary = verdict.summary.latest;
  const transition = summary.transition;
  const tag = `${id}${verdict.scheme === 'dark' ? '~dark' : ''}`;
  const relevant = ctx.deltas.has(id) || headTuple;

  if (pyTruthy(summary.visualErrors)) {
    buckets.screenshotErrors.push(tag);
  }

  if (transition === 'errored') {
    buckets.erroredTotal += 1;

    if (relevant) {
      buckets.errored.push(tag);
    }

    return;
  }

  if (transition === 'input-rejected') {
    // Nothing to compare against: the input does nothing in any engine that ran.
    if (relevant) {
      buckets.inputRejected.push(tag);
    }

    return;
  }

  sortJudgedVerdict({ id, verdict, entry, source, headTuple, tag }, buckets, candidates);
  sideFindings(ctx, { id, verdict, entry, tag }, buckets);
}

/**
 * @typedef {object} VerdictSite One verdict of one case, with what the buckets need to know.
 * @property {string} id
 * @property {VerdictRecord} verdict
 * @property {CaseRecord | Record<string, never>} entry
 * @property {string} [source]
 * @property {boolean} [headTuple] A test case only head's tests record (a new or changed expectation).
 * @property {string} tag
 */

/**
 * The main bucket of a judged verdict: outside the targets, a regression candidate, engine
 * divergence, or new output that renders differently.
 *
 * @param {VerdictSite} site
 * @param {OracleBuckets} buckets
 * @param {BadCandidate[]} candidates
 * @returns {void}
 */
function sortJudgedVerdict(site, buckets, candidates) {
  const { id, verdict, headTuple = false, tag } = site;
  const summary = verdict.summary.latest;
  const transition = summary.transition;
  const headDifferent = summary.head === 'different';
  const woke = inertLiveNote(summary);
  const divergent = pyTruthy(summary.divergent) && headDifferent && !pyTruthy(summary.neutral);

  if (differsOutsideTargets(site)) {
    buckets.outsideTargets.push(tag);
  } else if (BAD_TRANSITIONS.includes(transition)) {
    candidates.push({ tag: tag + woke, id, source: String(site.source) });
  } else if (divergent && (transition === 'still-different' || headTuple)) {
    buckets.divergent.push(divergenceItem(site, woke));
  } else if (headDifferent && (transition === 'introduced' || headTuple)) {
    buckets.newBad.push(tag);
  }
}

/**
 * Output for explicit targets is judged only by the engines of those targets: a case head made
 * worse (or new head output) that differs only in engines outside them is ignored.
 *
 * @param {VerdictSite} site
 * @returns {boolean}
 */
function differsOutsideTargets(site) {
  const { verdict, entry, headTuple = false } = site;
  const summary = verdict.summary.latest;
  const judgedBad =
    BAD_TRANSITIONS.includes(summary.transition) || summary.transition === 'introduced' || headTuple;

  return (
    judgedBad &&
    summary.head === 'different' &&
    pyTruthy((entry.request || {}).targets) &&
    engineStatuses(verdict).size > 0 &&
    wrongIn(verdict, entry, 'head').length === 0
  );
}

/**
 * ` [input inert, output live in <engines>]` when the input does nothing but the output does.
 *
 * @param {ProfileSummary} summary
 * @returns {string}
 */
function inertLiveNote(summary) {
  return pyTruthy(summary.inertLive)
    ? ` [input inert, output live in ${(summary.inertLive ?? []).join(', ')}]`
    : '';
}

/**
 * `<tag> [head equivalent in …; different in …; base different in …]`
 *
 * @param {VerdictSite} site
 * @param {string} woke
 * @returns {string}
 */
function divergenceItem(site, woke) {
  const { verdict, entry, tag } = site;
  const baseWrong = wrongIn(verdict, entry, 'base');
  const engines = pyGet(verdict.summary.latest, 'enginesHead', { ok: [], bad: [], divergent: false });
  const list = (/** @type {string[]} */ names) => names.join(', ') || 'none';

  return `${tag} [head equivalent in ${list(pyGet(engines, 'ok', []))}; different in ${list(pyGet(engines, 'bad', []))}; base different in ${list(baseWrong)}]${woke}`;
}

/**
 * The buckets a judged verdict can be in besides its main one: tolerance drift, rejections,
 * pixels, legacy regressions, unverified deltas.
 *
 * @param {EvalContext} ctx
 * @param {VerdictSite} site
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
function sideFindings(ctx, site, buckets) {
  const { id, verdict, entry, tag } = site;
  const summary = verdict.summary.latest;

  if (summary.transition === 'near-introduced') {
    buckets.near.push(tag);
  }

  const [rejectedBase, rejectedHead] = rejectedCounts(verdict, entry);

  if (rejectedHead > rejectedBase) {
    buckets.rejected.push(tag);
  }

  if (pyTruthy(summary.visualHead) && !pyTruthy(summary.visualBase)) {
    buckets.visual.push(tag);
  }

  for (const [profile, legacy] of sortedEntries(pyGet(verdict.summary, 'legacy', {}))) {
    if (BAD_TRANSITIONS.includes(legacy.transition)) {
      buckets.legacyRegressed.push(`${tag}@${profile}`);
    }
  }

  if (summary.transition === 'unverified' && ctx.deltas.has(id)) {
    buckets.unverified.push(tag);
  }
}

/**
 * Pre-existing behavior extended to new targets: head's output for a regressed request equals what
 * base already produces (and pins in a test) for the same input under other targets. Such a case
 * is a decision (O10), not a regression; the rest are O1, or O7 for WPT.
 *
 * @param {EvalContext} ctx
 * @param {BadCandidate[]} candidates
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
function splitCandidates(ctx, candidates, buckets) {
  if (candidates.length > 0) {
    findExtended(ctx, candidates, buckets.extendedBy);
  }

  for (const { tag, id, source } of candidates) {
    const baseTest = buckets.extendedBy.get(id);

    if (baseTest) {
      buckets.extended.push(`${tag} [base test ${baseTest} already gives this output for other targets]`);
    } else if (source === 'wpt') {
      buckets.wptRegressed.push(tag);
    } else {
      buckets.regressed.push(tag);
    }
  }
}

/**
 * @typedef {object} BaseRendering A base (or both-sides) sheet test and what base printed.
 * @property {string} targets Its targets, as a comparable key.
 * @property {unknown} code
 * @property {string} id
 */

/**
 * @param {EvalContext} ctx
 * @param {BadCandidate[]} candidates
 * @param {Map<string, string>} extendedBy
 * @returns {void}
 */
function findExtended(ctx, candidates, extendedBy) {
  const byInput = baseRenderings(ctx);
  const headOutputs = ctx.outputs('head');

  for (const { id } of candidates) {
    const request = ctx.caseOf(id).request || {};
    const head = headOutputs.get(id) ?? {};
    const mine = targetsKey(request.targets);
    const hit = (byInput.get(inputKey(request)) ?? []).find(
      (base) => base.targets !== mine && pyTruthy(head.ok) && base.code === (head.code ?? null),
    );

    if (hit && pyTruthy(hit.id)) {
      extendedBy.set(id, hit.id);
    }
  }
}

/**
 * What base prints for each sheet input its own tests record (base and both-sides tuples that
 * succeeded on base), keyed by input, in case-id order.
 *
 * @param {EvalContext} ctx
 * @returns {Map<string, BaseRendering[]>}
 */
function baseRenderings(ctx) {
  const baseOutputs = ctx.outputs('base');
  /** @type {Map<string, BaseRendering[]>} */
  const byInput = new Map();

  for (const entry of [...ctx.cases.values()].sort((a, b) => compareCodePoints(a.id, b.id))) {
    const request = entry.request || {};
    const output = baseOutputs.get(entry.id) ?? {};
    const baseTest = entry.source === 'tuple' && (entry.side === 'base' || entry.side === 'both');

    if (baseTest && request.kind === 'sheet' && pyTruthy(output.ok)) {
      const key = inputKey(request);
      const list = byInput.get(key) ?? [];

      list.push({ targets: targetsKey(request.targets), code: output.code ?? null, id: entry.id });
      byInput.set(key, list);
    }
  }

  return byInput;
}

/**
 * The input a sheet request prints: its CSS and output switches.
 *
 * @param {Partial<import('../../types.js').AdapterRequest>} request
 * @returns {string}
 */
function inputKey(request) {
  return dumps([request.css ?? null, pyTruthy(request.minify), pyTruthy(request.compact)]);
}

/**
 * Targets as a comparable key (sorted browser -> version pairs).
 *
 * @param {import('../../types.js').Targets | null | undefined} targets
 * @returns {string}
 */
function targetsKey(targets) {
  const pairs = Object.entries(targets && pyTruthy(targets) ? targets : {}).sort(([a], [b]) =>
    compareCodePoints(a, b),
  );

  return dumps(pairs);
}

/**
 * The case ids the browsers show head worse than base for (O1, O2, O4, O7).
 *
 * @param {OracleBuckets} buckets
 * @returns {Set<string>}
 */
export function oracleBad(buckets) {
  return new Set(
    [...buckets.regressed, ...buckets.wptRegressed, ...buckets.newBad, ...buckets.legacyRegressed].map(
      caseId,
    ),
  );
}

/**
 * Evaluate O1-O10 (all SKIP when the oracle did not run).
 *
 * @param {EvalContext} ctx
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
export function oracleChecks(ctx, buckets) {
  if (!pyTruthy(ctx.oracle)) {
    for (const id of ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9', 'O10']) {
      ctx.checks.add(id, 'SKIP', 'oracle stage did not run');
    }

    return;
  }

  regressionChecks(ctx, buckets);
  verificationCheck(ctx, buckets);
  slotCheck(
    ctx,
    'O9',
    buckets.divergent,
    (count) => `${count} case(s) where engines read the input differently; decide against the spec`,
    buckets.divergent.length > 0 ? `${buckets.divergent.length} engine-divergent case(s) classified` : '',
  );
  decisionCheck(ctx, buckets);
}

/**
 * A slot check: unclassified items fail it; when every item is classified and some as REGRESSION,
 * it keeps FAIL without a finding (the classification's finding reports them).
 *
 * @param {EvalContext} ctx
 * @param {string} check
 * @param {string[]} tags
 * @param {(count: number) => string} failText
 * @param {string} passText
 * @returns {void}
 */
function slotCheck(ctx, check, tags, failText, passText) {
  const open = tags.filter((tag) => !ctx.classificationOf(tag));
  const regression = tags.filter((tag) => ctx.classificationOf(tag)?.classification === 'REGRESSION');

  ctx.checks.open.set(check, open);

  if (open.length > 0) {
    ctx.checks.add(check, 'FAIL', failText(open.length), open);
  } else if (regression.length > 0) {
    ctx.checks.add(
      check,
      'FAIL',
      `${regression.length} case(s) classified REGRESSION (reported as findings)`,
      regression,
      {
        finding: false,
      },
    );
  } else {
    ctx.checks.add(check, 'PASS', passText);
  }
}

/**
 * O1-O7: regressions, new output, rejections, legacy engines, drift, pixels, WPT.
 *
 * @param {EvalContext} ctx
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
function regressionChecks(ctx, buckets) {
  const { regressed, newBad, outsideTargets } = buckets;
  const outsideNote =
    outsideTargets.length > 0
      ? `; ${outsideTargets.length} case(s) differ only in engines outside their targets (ignored)`
      : '';

  slotCheck(
    ctx,
    'O1',
    regressed,
    (count) =>
      `${count} case(s) where head is worse than base in current engines (base equivalent, or head adds differences)${outsideNote}`,
    (regressed.length > 0 ? `${regressed.length} regression(s) cleared in analysis` : '') + outsideNote,
  );
  slotCheck(
    ctx,
    'O2',
    newBad,
    (count) => `${count} new/changed test or flag-only output(s) render differently from their input`,
    newBad.length > 0 ? `${newBad.length} cleared in analysis` : '',
  );
  slotCheck(
    ctx,
    'O3',
    buckets.rejected,
    (count) => `${count} case(s) emit CSS an in-target engine rejects with no surviving fallback`,
    '',
  );
  legacyCheck(ctx, buckets);
  slotCheck(ctx, 'O5', buckets.near, (count) => `${count} case(s) drift within tolerance (color/number)`, '');
  visualCheck(ctx, buckets);
  wptCheck(ctx, buckets);
}

/**
 * O4: lowering regressions, only when a legacy profile ran.
 *
 * @param {EvalContext} ctx
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
function legacyCheck(ctx, buckets) {
  const profiles = Object.keys(pyGet(ctx.oracle, 'profiles', {}));

  if (pyTruthy(ctx.oracle.profiles) && profiles.length > 1) {
    slotCheck(
      ctx,
      'O4',
      buckets.legacyRegressed,
      (count) => `${count} lowering regression(s) in legacy engines`,
      profiles.filter((profile) => profile !== 'latest').join(', '),
    );
  } else {
    ctx.checks.add('O4', 'SKIP', 'no legacy engine profile ran');
  }
}

/**
 * O6: different pixels; cases whose screenshots failed are named so a PASS is not overread.
 *
 * @param {EvalContext} ctx
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
function visualCheck(ctx, buckets) {
  let shotNote = '';

  if (buckets.screenshotErrors.length > 0) {
    /** @type {Set<string>} */
    const engines = new Set();

    for (const verdicts of ctx.verdicts.values()) {
      for (const verdict of verdicts) {
        for (const engine of verdict.summary.latest.visualErrors || []) {
          engines.add(engine);
        }
      }
    }

    const failedIn = [...engines].sort(compareCodePoints).join(', ');

    shotNote = `; ${buckets.screenshotErrors.length} case(s) had no screenshot comparison (screenshot failed in ${failedIn})`;
  }

  slotCheck(
    ctx,
    'O6',
    buckets.visual,
    (count) => `${count} case(s) render different pixels${shotNote}`,
    pyLstrip(shotNote, '; '),
  );
}

/**
 * O7: WPT regressions, when the corpus has WPT cases.
 *
 * @param {EvalContext} ctx
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
function wptCheck(ctx, buckets) {
  const hasWpt = [...ctx.cases.values()].some((entry) => entry.source === 'wpt');

  if (hasWpt || buckets.wptRegressed.length > 0) {
    slotCheck(ctx, 'O7', buckets.wptRegressed, (count) => `${count} WPT case(s) regressed`, '');
  } else {
    ctx.checks.add('O7', 'SKIP', '');
  }
}

/**
 * O8: every delta verified by a browser or classified. Errored engine jobs alone make it
 * INCONCLUSIVE (the oracle could not run), not a failure.
 *
 * @param {EvalContext} ctx
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
function verificationCheck(ctx, buckets) {
  const unclassified = (/** @type {string[]} */ tags) => tags.filter((tag) => !ctx.classificationOf(tag));
  const notRun = [...ctx.deltas.keys()].sort(compareCodePoints).filter((id) => !ctx.verdicts.has(id));
  const open = unclassified([...buckets.unverified, ...notRun]);
  const erroredOpen = unclassified(buckets.errored);
  const rerun = 're-run with `lcr oracle --rerun`';

  ctx.checks.open.set('O8', [...open, ...erroredOpen]);

  if (open.length > 0) {
    const errNote = erroredOpen.length > 0 ? `; ${erroredOpen.length} errored in an engine (${rerun})` : '';

    ctx.checks.add(
      'O8',
      'FAIL',
      `${open.length} delta(s) unverified and not cleared in analysis.json${errNote}`,
      [...open, ...erroredOpen],
    );
  } else if (erroredOpen.length > 0) {
    ctx.checks.add(
      'O8',
      'INCONCLUSIVE',
      `${erroredOpen.length} delta(s) errored in an engine: the oracle could not run them (${rerun}, or classify)`,
      erroredOpen,
    );
  } else {
    const outside =
      buckets.erroredTotal > 0 ? `; ${buckets.erroredTotal} errored engine job(s) outside the deltas` : '';

    ctx.checks.add('O8', 'PASS', `${ctx.deltas.size} delta(s) verified or cleared${outside}`);
  }
}

/**
 * O10: the decision bucket, cases the browsers cannot judge against base (input rejected in every
 * engine, or base behavior extended to new targets). A note until classified; never a blocker.
 *
 * @param {EvalContext} ctx
 * @param {OracleBuckets} buckets
 * @returns {void}
 */
function decisionCheck(ctx, buckets) {
  const decision = [...buckets.inputRejected, ...buckets.extended];
  const open = decision.filter((tag) => !ctx.classificationOf(tag));

  ctx.checks.open.set('O10', open);

  if (open.length > 0) {
    const rejected = open.filter((tag) => buckets.inputRejected.includes(tag)).length;

    ctx.checks.add(
      'O10',
      'PARTIAL',
      `${open.length} case(s) the browsers cannot judge against base: ${rejected} with input rejected in every engine, ${open.length - rejected} extending base behavior to new targets`,
      open,
      { severity: 'NOTE' },
    );
  } else {
    ctx.checks.add(
      'O10',
      'PASS',
      decision.length > 0 ? `${decision.length} decision case(s) classified` : '',
    );
  }
}
