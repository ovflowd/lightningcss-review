/**
 * Probe assertions and check T6: an `expect:` assertion that holds on base must not fail on head.
 *
 * Stage: report. Reads corpus.json (`probes[].assert`, the idempotency second passes) and the
 * oracle verdicts. The corpus stage decides the plain assertions; `idempotent` is filled in from
 * the second minify pass and `equivalent` from the in-target engines' verdict (null while
 * undecided).
 *
 * An assertion that holds on base only because base is wrong another way is not the PR's defect:
 * when a PRE_EXISTING classification or a FAIL_PRE_EXISTING answer names the probe (directly, or
 * through the analysis finding it links), T6 reports it as a note.
 */
import { pyGet, pyList } from '../../core/py-value.js';
import { compareCodePoints, pyStr, pyTruthy } from '../../core/py.js';
import { caseRefs, light, sideEquivalent } from '../cases.js';
import { analysisFindingIds } from './completeness.js';

/**
 * @import { ProbeResult, Side } from '../../types.js'
 * @import { EvalContext } from '../context.js'
 */

/** @typedef {Map<string, boolean | null>} AssertionResults Assertion -> pass / fail / undecided. */

/** @typedef {Record<Side, AssertionResults>} ProbeAsserts */

/**
 * @typedef {object} ProbeOutcome What T6 found, for A2 and the report's "fixed" list.
 * @property {string[]} fixed `<probe case>: <assertion>` that fail on base and pass on head.
 */

/**
 * Every probe's assertion results per side, with `idempotent` and `equivalent` decided where the
 * corpus left them open.
 *
 * @param {EvalContext} ctx
 * @returns {Map<string, ProbeAsserts>}
 */
export function probeAssertions(ctx) {
  const { corpus } = ctx;
  const idempotency = { head: secondPasses(corpus.idempotency), base: secondPasses(corpus.idempotency_base) };
  /** @type {Map<string, ProbeAsserts>} */
  const asserts = new Map();

  for (const probe of pyGet(corpus, 'probes', /** @type {ProbeResult[]} */ ([]))) {
    const recorded = probe.assert || /** @type {Partial<ProbeResult['assert']>} */ ({});
    /** @type {ProbeAsserts} */
    const results = {
      base: new Map(Object.entries(recorded.base || {})),
      head: new Map(Object.entries(recorded.head || {})),
    };

    for (const side of /** @type {const} */ (['head', 'base'])) {
      const pass = idempotency[side];

      if (results[side].get('idempotent') === null && Object.hasOwn(pass, probe.id)) {
        results[side].set('idempotent', pass[probe.id].stable);
      }
    }

    const verdict = light(ctx.verdicts.get(probe.id));

    if (verdict) {
      for (const side of /** @type {const} */ (['base', 'head'])) {
        if (results[side].get('equivalent') === null) {
          results[side].set('equivalent', sideEquivalent(verdict, ctx.caseOf(probe.id), side));
        }
      }
    }

    asserts.set(probe.id, results);
  }

  return asserts;
}

/**
 * @param {Record<string, { stable: boolean }> | null | undefined} passes
 * @returns {Record<string, { stable: boolean }>}
 */
function secondPasses(passes) {
  return passes && pyTruthy(passes) ? passes : {};
}

/**
 * T6, plus the list of assertions this PR fixes.
 *
 * @param {EvalContext} ctx
 * @param {Map<string, ProbeAsserts>} asserts
 * @param {string[]} unstable Case ids R2 already charges for idempotency.
 * @returns {ProbeOutcome}
 */
export function probeCheck(ctx, asserts, unstable) {
  const outcome = classifyAssertions(ctx, asserts, new Set(unstable));
  const { broke, brokePre, failing, fixed } = outcome;
  const fixedNote = fixed.length > 0 ? `; ${fixed.length} assertion(s) now pass (fixed by this PR)` : '';

  if (!pyTruthy(ctx.corpus)) {
    ctx.checks.add('T6', 'SKIP', 'corpus stage did not run');
  } else if (broke.length > 0) {
    const more =
      brokePre.length + failing.length > 0 ? `; ${brokePre.length + failing.length} more fail on head` : '';

    ctx.checks.add(
      'T6',
      'FAIL',
      `${broke.length} probe assertion(s) hold on base and fail on head${more}${fixedNote}`,
      [...broke, ...brokePre, ...failing],
    );
  } else if (brokePre.length > 0 || failing.length > 0) {
    const parts = [];

    if (brokePre.length > 0) {
      parts.push(
        `${brokePre.length} probe assertion(s) hold on base only because base is wrong another way (pre-existing)`,
      );
    }

    if (failing.length > 0) {
      parts.push(`${failing.length} probe assertion(s) fail on head`);
    }

    ctx.checks.add('T6', 'PARTIAL', parts.join('; ') + fixedNote, [...brokePre, ...failing], {
      severity: 'NOTE',
    });
  } else {
    const total = [...asserts.values()].reduce((sum, results) => sum + results.head.size, 0);

    ctx.checks.add('T6', 'PASS', `${total} assertion(s) checked${fixedNote}`);
  }

  return { fixed };
}

/**
 * @typedef {object} AssertionBuckets
 * @property {string[]} broke Hold on base, fail on head.
 * @property {string[]} brokePre The same, but base is wrong another way (pre-existing).
 * @property {string[]} failing Fail on head on a PR probe or a changed curated one.
 * @property {string[]} fixed Fail on base, pass on head.
 */

/**
 * @param {EvalContext} ctx
 * @param {Map<string, ProbeAsserts>} asserts
 * @param {Set<string>} unstable
 * @returns {AssertionBuckets}
 */
function classifyAssertions(ctx, asserts, unstable) {
  /** @type {AssertionBuckets} */
  const buckets = { broke: [], brokePre: [], failing: [], fixed: [] };
  const probes = pyGet(ctx.corpus, 'probes', /** @type {ProbeResult[]} */ ([]));

  if (probes.length === 0) {
    return buckets;
  }

  const markOf = preExistingMarks(ctx);

  for (const probe of [...probes].sort((a, b) => compareCodePoints(a.id, b.id))) {
    if (probe.origin === 'pr' || probe.origin === 'curated') {
      classifyProbe(probe, /** @type {ProbeAsserts} */ (asserts.get(probe.id)), unstable, markOf, buckets);
    }
  }

  return buckets;
}

/**
 * @param {ProbeResult} probe
 * @param {ProbeAsserts} results
 * @param {Set<string>} unstable
 * @param {(id: string) => string | null} markOf
 * @param {AssertionBuckets} buckets
 * @returns {void}
 */
function classifyProbe(probe, results, unstable, markOf, buckets) {
  for (const name of [...results.head.keys()].sort(compareCodePoints)) {
    const onBase = results.base.get(name) ?? null;
    const onHead = results.head.get(name) ?? null;

    if (onBase === false && onHead === true) {
      buckets.fixed.push(`${probe.id}: ${name}`);
    }

    // `equivalent` is decided by the oracle checks and `idempotent` by R2 when R2 lists the case.
    if (name !== 'equivalent' && !(name === 'idempotent' && unstable.has(probe.id))) {
      classifyFailure(probe, name, [onBase, onHead], markOf, buckets);
    }
  }
}

/**
 * Bucket an assertion that fails on head: broken by the PR (or by a pre-existing base bug), or
 * failing on a PR probe or a changed curated one.
 *
 * @param {ProbeResult} probe
 * @param {string} name
 * @param {[boolean | null, boolean | null]} results Base and head.
 * @param {(id: string) => string | null} markOf
 * @param {AssertionBuckets} buckets
 * @returns {void}
 */
function classifyFailure(probe, name, [onBase, onHead], markOf, buckets) {
  if (onBase === true && onHead === false) {
    const mark = markOf(probe.id);

    if (mark) {
      buckets.brokePre.push(
        `${probe.id}: ${name} (holds on base, fails on head; base is wrong another way per ${mark})`,
      );
    } else {
      buckets.broke.push(`${probe.id}: ${name} (holds on base, fails on head)`);
    }
  } else if (onHead === false && (probe.origin === 'pr' || pyTruthy(probe.changed))) {
    buckets.failing.push(`${probe.id}: ${name}${onBase === false ? ' (fails on base too)' : ''}`);
  }
}

/**
 * The case ids each analysis finding's evidence cites, by finding id (`F<n>` without one).
 *
 * @param {EvalContext} ctx
 * @returns {Map<string, Set<string>>}
 */
function findingCaseRefs(ctx) {
  const findings = pyGet(ctx.analysis, 'findings', []);

  return new Map(
    analysisFindingIds(findings).map((id, index) => {
      const evidence = pyList(findings[index].evidence || [])
        .map(pyStr)
        .join(' ');

      return [id, new Set(caseRefs(evidence, ctx.known))];
    }),
  );
}

/**
 * @typedef {object} PreExistingMark
 * @property {string} label e.g. `PRE_EXISTING p-color/x` or `FAIL_PRE_EXISTING COLOR-01`.
 * @property {unknown} id The classification's pattern (none for an answer).
 * @property {unknown} finding The analysis finding it links.
 * @property {string} text Its reason and evidence, searched for case ids.
 */

/**
 * The PRE_EXISTING classification or FAIL_PRE_EXISTING answer that names a probe, or links an
 * analysis finding that cites it. Only answers to this run's checklist count: their evidence is
 * what A3 validates.
 *
 * @param {EvalContext} ctx
 * @returns {(id: string) => string | null}
 */
function preExistingMarks(ctx) {
  const { analysis, known } = ctx;
  const findingRefs = findingCaseRefs(ctx);
  /** @type {PreExistingMark[]} */
  const marks = pyGet(analysis, 'deltas', [])
    .filter((entry) => entry.classification === 'PRE_EXISTING')
    .map((entry) => ({
      label: `PRE_EXISTING ${pyStr(pyGet(entry, 'id', ''))}`,
      id: entry.id ?? null,
      finding: entry.finding ?? null,
      text: `${pyStr(pyGet(entry, 'reason', ''))} ${pyStr(pyGet(entry, 'evidence', ''))}`,
    }));

  for (const item of ctx.checklist) {
    const answer = ctx.answers.get(item.item);

    if (answer?.answer === 'FAIL_PRE_EXISTING') {
      marks.push({
        label: `FAIL_PRE_EXISTING ${item.item}`,
        id: null,
        finding: answer.finding ?? null,
        text: `${pyStr(pyGet(answer, 'evidence', ''))} ${pyStr(pyGet(answer, 'note', ''))}`,
      });
    }
  }

  return (id) => {
    const mark = marks.find(
      (entry) =>
        entry.id === id ||
        caseRefs(entry.text, known).includes(id) ||
        (findingRefs.get(pyStr(entry.finding))?.has(id) ?? false),
    );

    return mark ? mark.label : null;
  };
}
