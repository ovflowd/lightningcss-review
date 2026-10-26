/**
 * Case summaries: the engines of one profile -> base/head status and the case's transition.
 *
 * Stage: oracle (analysis image, compare.mjs). Pure functions over the per-engine entries of
 * verdict.mjs. The transition (`fixed`, `regressed`, `both-equivalent`, …) is what the report's
 * checks read, so these rules decide verdicts:
 * - an errored engine never makes a case different or verified, unless the engines that ran
 *   already show head broke it;
 * - an engine where the input does nothing (inert) cannot judge whether an output behaves like
 *   it, unless an output applies styles there (dead CSS turned live: different);
 * - engines that split on the same output point at the input only when they read the input
 *   differently (`divergent`).
 */
import { compareValues } from './normalize.mjs';

/** @import { EngineEntry, EngineBucket, EngineSplit, ProfileSummary, StyleMap, VariantVerdict } from './types.mjs' */

/** @typedef {EngineEntry & { variants: { base: VariantVerdict, head: VariantVerdict } }} JudgedEntry */
/** @typedef {[engine: string, entry: JudgedEntry]} NamedEntry */

/** Severity of a side status; the worst over the judging engines is the profile's status. */
const STATUS_RANK = /** @type {Record<string, number>} */ ({
  equivalent: 0,
  'no-coverage': 1,
  near: 2,
  unknown: 1,
  different: 3,
  error: 3,
});

/** Statuses that count as "fine" for a side. */
const OK = new Set(['equivalent', 'near']);

/** Transitions for which an engine split is not reported as divergent. */
const NOT_DIVERGENT = ['regressed', 'errored', 'input-rejected', 'unverified'];

/**
 * @param {string[]} statuses
 * @returns {string}
 */
function worstStatus(statuses) {
  return statuses.reduce(
    (worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst),
    'equivalent',
  );
}

/**
 * @param {string} status
 * @returns {boolean}
 */
const isBad = (status) => status === 'different';

/**
 * The transition over the engines that can judge the case (not errored, input not inert).
 *
 * @param {string} base Worst base status.
 * @param {string} head Worst head status.
 * @param {EngineEntry[]} [judged] Their entries (for `overlap`).
 * @param {{ introduced?: boolean }} [options] `introduced`: base cannot run the request, so head
 *   is judged against the input alone.
 * @returns {string}
 */
export function transition(base, head, judged = [], { introduced = false } = {}) {
  if (introduced) {
    return head === 'unknown' ? 'unverified' : 'introduced';
  }

  if (base === 'unknown' || head === 'unknown') {
    return 'unverified';
  }

  if (base === 'no-coverage' && head === 'no-coverage') {
    return 'unverified';
  }

  // Base fine in every engine and head wrong in any: the PR broke it, whatever the other engines say.
  if (!isBad(base)) {
    return isBad(head) ? 'regressed' : fineTransition(base, head);
  }

  if (!isBad(head)) {
    return 'fixed';
  }

  return overlapTransition(judged);
}

/**
 * Both sides fine: a `near` head where base was exact is worth a look.
 *
 * @param {string} base
 * @param {string} head
 * @returns {string}
 */
function fineTransition(base, head) {
  return head === 'near' && base !== 'near' ? 'near-introduced' : 'both-equivalent';
}

/**
 * Both sides different: `worsened` when head only adds differences to base's, else
 * `still-different`.
 *
 * @param {EngineEntry[]} judged
 * @returns {string}
 */
function overlapTransition(judged) {
  /**
   * @param {'baseOnly' | 'headOnly'} key
   * @returns {number}
   */
  const sum = (key) =>
    judged.reduce((total, entry) => total + ((entry.overlap && entry.overlap[key]) || 0), 0);

  return sum('baseOnly') === 0 && sum('headOnly') > 0 ? 'worsened' : 'still-different';
}

/**
 * Whether an engine that is wrong on one side reads the input differently from an engine that is
 * fine on that side, on a property where it is wrong (e.g. one engine still implements an older
 * spec rule).
 *
 * @param {NamedEntry[]} judged
 * @param {Record<string, StyleMap | null | undefined> | null} touched Engine -> the reference
 *   profile's input `touched`.
 * @returns {boolean}
 */
function readsDiffer(judged, touched) {
  if (!touched) {
    return false;
  }

  for (const side of /** @type {const} */ (['base', 'head'])) {
    const fine = judged.filter(([, entry]) => OK.has(entry.variants[side].status)).map(([engine]) => engine);
    const wrongDiffs = judged
      .filter(([, entry]) => entry.variants[side].status === 'different')
      .flatMap(([, entry]) => entry.variants[side].diffs || [])
      .filter((d) => d.level === 'different' && d.ref !== null && d.ref !== undefined);

    for (const d of wrongDiffs) {
      for (const engine of fine) {
        const engineTouched = touched[engine];
        const value = engineTouched && engineTouched[d.key] ? engineTouched[d.key][d.prop] : undefined;

        if (value !== undefined && compareValues(d.prop, d.ref, value, 'same-engine').level === 'different') {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * An engine that rejects (part of) the input and sees it touch nothing. Valid input that only sets
 * initial values (`inputRejected === false`) still judges: an output that changes something there
 * is wrong.
 *
 * @param {EngineEntry} entry
 * @returns {boolean}
 */
const isInert = (entry) => entry.touched === 0 && entry.inputRejected !== false;

/**
 * @param {VariantVerdict} variant
 * @returns {boolean}
 */
const applies = (variant) => variant.status === 'different' || variant.status === 'near';

/**
 * A side of an engine where the input is inert but an output is live: applying styles is different.
 *
 * @param {VariantVerdict} variant
 * @returns {VariantVerdict}
 */
function wake(variant) {
  if (applies(variant)) {
    return { ...variant, status: 'different', reason: 'input-inert-output-live' };
  }

  return variant.status === 'no-coverage' ? { ...variant, status: 'equivalent' } : variant;
}

/**
 * @typedef {object} EngineGroups
 * @property {NamedEntry[]} named Engines with variants, by name.
 * @property {string[]} errored
 * @property {NamedEntry[]} live Engines that ran.
 * @property {string[]} inert Live engines left out: all three sheets inert there.
 * @property {string[]} inertLive Live engines where the input is inert but an output is not.
 * @property {NamedEntry[]} judged The engines that decide, inert-live ones woken.
 */

/**
 * Sort a profile's engines into the groups the summary needs.
 *
 * @param {EngineBucket} bucket
 * @returns {EngineGroups}
 */
function groupEngines(bucket) {
  const named = /** @type {NamedEntry[]} */ (
    Object.keys(bucket)
      .toSorted()
      .map((engine) => [engine, bucket[engine]])
      .filter(([, entry]) => /** @type {EngineEntry} */ (entry).variants)
  );
  const errored = named.filter(([, entry]) => entry.error).map(([engine]) => engine);
  const live = named.filter(([, entry]) => !entry.error);
  // Where the input is inert in every engine there is nothing to judge against (input-rejected).
  const someLive = live.some(([, entry]) => !isInert(entry));
  /**
   * @param {JudgedEntry} entry
   * @returns {boolean}
   */
  const woken = (entry) =>
    someLive && isInert(entry) && (applies(entry.variants.base) || applies(entry.variants.head));
  const judged = live
    .filter(([, entry]) => !isInert(entry) || woken(entry))
    .map(([engine, entry]) =>
      woken(entry)
        ? /** @type {NamedEntry} */ ([
            engine,
            { ...entry, variants: { base: wake(entry.variants.base), head: wake(entry.variants.head) } },
          ])
        : /** @type {NamedEntry} */ ([engine, entry]),
    );

  return {
    named,
    errored,
    live,
    inert: live.filter(([, entry]) => isInert(entry) && !woken(entry)).map(([engine]) => engine),
    inertLive: live.filter(([, entry]) => woken(entry)).map(([engine]) => engine),
    judged,
  };
}

/**
 * @param {NamedEntry[]} entries
 * @param {'base' | 'head'} side
 * @returns {string}
 */
function worstSide(entries, side) {
  return entries.length ? worstStatus(entries.map(([, entry]) => entry.variants[side].status)) : 'unknown';
}

/**
 * The profile's base/head status and transition.
 *
 * @param {EngineGroups} groups
 * @param {boolean} introduced
 * @returns {{ base: string, head: string, transition: string }}
 */
function profileTransition({ errored, live, judged }, introduced) {
  let base = worstSide(judged, 'base');
  let head = worstSide(judged, 'head');
  let result;

  if (!live.length) {
    result = errored.length ? 'errored' : 'unverified';
  } else if (!judged.length) {
    base = worstSide(live, 'base');
    head = worstSide(live, 'head');

    const acts = live.some(
      ([, e]) => e.variants.base.status === 'different' || e.variants.head.status === 'different',
    );

    result = acts ? 'input-rejected' : 'unverified';
  } else {
    result = transition(
      base,
      head,
      judged.map(([, entry]) => entry),
      { introduced },
    );
  }

  // A missing engine leaves the case undecided unless the engines that ran already show head broke it.
  const headBroke =
    result === 'regressed' || result === 'worsened' || (result === 'introduced' && head === 'different');

  if (errored.length && !headBroke) {
    result = 'errored';
  }

  return { base, head, transition: result };
}

/**
 * Engines fine and wrong on one side.
 *
 * @param {NamedEntry[]} judged
 * @param {'base' | 'head'} side
 * @returns {EngineSplit}
 */
function engineSplit(judged, side) {
  const ok = judged.filter(([, entry]) => OK.has(entry.variants[side].status)).map(([engine]) => engine);
  const bad = judged
    .filter(([, entry]) => entry.variants[side].status === 'different')
    .map(([engine]) => engine);

  return { ok, bad, divergent: ok.length > 0 && bad.length > 0 };
}

/**
 * Each engine's base/head status; woken engines carry the reason.
 *
 * @param {EngineGroups} groups
 * @returns {ProfileSummary['engines']}
 */
function engineStatuses({ named, judged, inertLive }) {
  /** @type {ProfileSummary['engines']} */
  const engines = {};

  for (const [engine, entry] of named) {
    engines[engine] = { base: entry.variants.base.status, head: entry.variants.head.status };
  }

  for (const [engine, entry] of judged) {
    if (inertLive.includes(engine)) {
      engines[engine] = {
        base: entry.variants.base.status,
        head: entry.variants.head.status,
        reason: 'input-inert-output-live',
      };
    }
  }

  return engines;
}

/**
 * The summary of a case in one profile.
 *
 * @param {EngineBucket} bucket Engine -> entry.
 * @param {{ introduced?: boolean, touched?: Record<string, StyleMap | null | undefined> | null }} [options]
 *   `touched`: engine -> the reference profile's input `touched` (for `divergent`).
 * @returns {ProfileSummary}
 */
export function summarize(bucket, { introduced = false, touched = null } = {}) {
  const groups = groupEngines(bucket);
  const { live, judged, inert, inertLive, errored } = groups;
  const { base, head, transition: result } = profileTransition(groups, introduced);
  const enginesBase = engineSplit(judged, 'base');
  const enginesHead = engineSplit(judged, 'head');
  // Engines splitting on the same output only point at the input when they read the input
  // differently: one rejects part of it, it does nothing in one of them, or it computes differently.
  const inputDependent =
    inert.length > 0 ||
    inertLive.length > 0 ||
    new Set(judged.map(([, entry]) => entry.inputSig || '')).size > 1 ||
    readsDiffer(judged, touched);
  const divergent =
    !NOT_DIVERGENT.includes(result) && (enginesBase.divergent || enginesHead.divergent) && inputDependent;
  const neutral =
    live.length > 0 &&
    live.every(
      ([, entry]) =>
        entry.variants.base.sig !== undefined &&
        entry.variants.base.sig === entry.variants.head.sig &&
        entry.variants.base.status === entry.variants.head.status,
    );
  const entries = Object.values(bucket);
  /**
   * @param {'base' | 'head'} side
   * @returns {number}
   */
  const rejected = (side) =>
    live.reduce((total, [, entry]) => total + (entry.variants[side].hardRejected || 0), 0);
  /**
   * @param {'base' | 'head'} side
   * @returns {boolean}
   */
  const visual = (side) => entries.some((entry) => entry.visual && entry.visual[side] === 'pixel-different');

  return {
    base,
    head,
    transition: result,
    rejectedBase: rejected('base'),
    rejectedHead: rejected('head'),
    visualBase: visual('base'),
    visualHead: visual('head'),
    visualErrors: Object.keys(bucket)
      .toSorted()
      .filter((engine) => bucket[engine].visualError),
    enginesBase,
    enginesHead,
    engines: engineStatuses(groups),
    errored,
    inert,
    inertLive,
    inputDependent,
    divergent,
    neutral,
  };
}
