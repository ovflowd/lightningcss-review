/**
 * Per-engine verdicts: one engine's raw result for one job -> statuses for base and head.
 *
 * Stage: oracle (analysis image, compare.mjs). Pure functions; compare.mjs does the I/O and
 * summary.mjs combines the engines of a profile into a transition.
 *
 * Two modes:
 * - `same-engine` (reference profile): each output is compared with the input as read by the
 *   same engine. Differences come from the runner (`diff`), relative to the input.
 * - `lowering` (legacy profiles, cases with targets): a legacy engine's reading of each output is
 *   compared with the reference engine's reading of the input, on the properties the reference
 *   engine saw the input touch. That is what lowering promises: old engines render the output as
 *   new engines render the input.
 *
 * Base and head are always judged by the same rules (symmetry), so a transition between them
 * reflects the PR alone.
 */
import { compareValues } from './normalize.mjs';
import { sideRejections } from './rejections.mjs';
import { worstLevel } from './tolerance.mjs';

/** @import { SheetJob, SnapshotResult, SnapshotVariant, StyleMap, ValueDiff, VariantVerdict, EngineEntry, EngineResult, PropertyResult, Job, OracleCase, ValidityProbe } from './types.mjs' */

/**
 * Lightning CSS target key of each engine: config/engines.json `engine_to_target`, which this
 * container-side script cannot read.
 */
export const ENGINE_TARGET = /** @type {Record<string, string>} */ ({
  chromium: 'chrome',
  firefox: 'firefox',
  webkit: 'safari',
});

/** The two outputs a case compares, always in this order. */
const SIDES = /** @type {const} */ (['base', 'head']);

/** Diffs and rejections stored per side (the counts stay exact). */
const MAX_DIFFS = 12;
const MAX_REJECTED_DECLS = 12;
const MAX_REJECTED_SELECTORS = 8;
const MAX_REJECTED_PRELUDES = 8;

/** Order of stored diffs: the worst first, not the first in DOM order. */
const DIFF_RANK = /** @type {Record<string, number>} */ ({
  different: 0,
  near: 1,
  'custom-changed': 2,
  'space-changed': 3,
  noise: 4,
});
const UNRANKED = 9;

/** Lightning CSS's own polyfill toggles (light-dark(): `--lightningcss-light`/`-dark`). */
const POLYFILL_PREFIX = '--lightningcss-';

/**
 * Lightning CSS's version encoding of a browser version (`major << 16 | minor << 8 | patch`), to
 * compare an engine with a case's targets.
 *
 * @param {unknown} version
 * @returns {number}
 */
export function encode(version) {
  const parts = String(version)
    .split('.')
    .map((part) => parseInt(part, 10) || 0);

  return ((parts[0] || 0) << 16) | ((parts[1] || 0) << 8) | (parts[2] || 0);
}

/**
 * Used values that follow from layout (sizes, origins, px line heights) shift with fonts and engine
 * versions. Unless a sheet declares the property, a shorthand of it or a logical equivalent,
 * legacy lanes compare them with the legacy engine's own input, never with the reference engine's.
 */
const LAYOUT_RELATED = /** @type {Record<string, string[]>} */ ({
  width: ['width', 'inline-size', 'block-size'],
  height: ['height', 'block-size', 'inline-size'],
  'inline-size': ['inline-size', 'width', 'height'],
  'block-size': ['block-size', 'width', 'height'],
  'line-height': ['line-height', 'font'],
  'background-origin': ['background-origin', 'background'],
  'mask-origin': ['mask-origin', 'mask'],
});

/** A px length, as engines print used values. */
const PX = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?px$/i;

/**
 * @param {unknown} prop
 * @returns {string}
 */
function unprefixed(prop) {
  return String(prop)
    .toLowerCase()
    .replace(/^-(webkit|moz|ms|o)-/, '');
}

/**
 * Whether a property's value is layout-derived here (see LAYOUT_RELATED). `line-height` only when
 * both values are px (a keyword is not layout-derived).
 *
 * @param {string} prop
 * @param {unknown} ref
 * @param {unknown} val
 * @param {Set<string>} declared Unprefixed properties any sheet of the job declares.
 * @returns {boolean}
 */
export function layoutDerived(prop, ref, val, declared) {
  const name = unprefixed(prop);

  if (name === 'line-height' && !(PX.test(String(ref).trim()) && PX.test(String(val).trim()))) {
    return false;
  }

  const related = LAYOUT_RELATED[name] || (name.endsWith('-origin') ? [name] : null);

  return Boolean(related) && !(/** @type {string[]} */ (related).some((r) => declared.has(r)));
}

/**
 * Same engine: the runner's diff rows of a variant, classified; equal values are dropped.
 *
 * @param {SnapshotVariant} variant
 * @returns {ValueDiff[]}
 */
function sameEngineDiffs(variant) {
  /** @type {ValueDiff[]} */
  const diffs = [];

  for (const [key, prop, ref, val] of variant.diff || []) {
    // Polyfill toggles are not author CSS; their effect shows in the properties that consume them.
    if (prop.startsWith(POLYFILL_PREFIX)) {
      continue;
    }

    const comparison = compareValues(prop, ref, val, 'same-engine');

    if (comparison.level !== 'equal') {
      diffs.push({ key, prop, ref, val, level: comparison.level, details: comparison.details });
    }
  }

  return diffs;
}

/**
 * This engine's own reading of the input for one element and property, if usable.
 *
 * @param {StyleMap | null} own
 * @param {string} key
 * @param {string} prop
 * @returns {string | undefined}
 */
function ownValue(own, key, prop) {
  return own && own[key] ? own[key][prop] : undefined;
}

/**
 * Lowering: a variant's values against the reference engine's touched input values. Properties
 * this engine does not know (no value) are skipped; layout-derived values are compared with
 * `own` (this engine's reading of the input) and skipped without it.
 *
 * @param {SnapshotVariant} variant
 * @param {StyleMap} touched
 * @param {Set<string>} declared
 * @param {StyleMap | null} own
 * @returns {ValueDiff[]}
 */
function loweringDiffs(variant, touched, declared, own) {
  const values = variant.values || {};
  /** @type {ValueDiff[]} */
  const diffs = [];

  for (const [key, touchedValues] of Object.entries(touched)) {
    for (const [prop, refValue] of Object.entries(touchedValues)) {
      const val = values[key] ? values[key][prop] : undefined;

      if (val === undefined || val === '' || prop.startsWith(POLYFILL_PREFIX)) {
        continue;
      }

      const layout = layoutDerived(prop, refValue, val, declared);
      const ref = layout ? ownValue(own, key, prop) : refValue;

      if (layout && (ref === undefined || ref === '')) {
        continue;
      }

      const comparison = compareValues(prop, ref, val, 'lowering');

      if (comparison.level !== 'equal') {
        diffs.push({
          key,
          prop,
          ref,
          val,
          level: comparison.level,
          details: comparison.details,
          ...(layout ? { refFrom: /** @type {const} */ ('engine-input') } : {}),
        });
      }
    }
  }

  return diffs;
}

/**
 * The classified differences of one variant.
 *
 * @param {'same-engine' | 'lowering'} mode
 * @param {SnapshotVariant} variant
 * @param {StyleMap} touched
 * @param {Set<string>} [declared]
 * @param {StyleMap | null} [own]
 * @returns {ValueDiff[]}
 */
function rawDiffs(mode, variant, touched, declared = new Set(), own = null) {
  return mode === 'same-engine' ? sameEngineDiffs(variant) : loweringDiffs(variant, touched, declared, own);
}

/**
 * Lowering: a difference base and head share exactly comes from the engine version spread or
 * predates the PR; either way it cannot decide the transition. The shared differences are dropped
 * only when something else is different, so a defect both sides have is still reported (as
 * neutral). Returns the number dropped; edits `diffsBySide` in place.
 *
 * @param {{ base?: ValueDiff[], head?: ValueDiff[] }} diffsBySide
 * @returns {number}
 */
function dropSharedDiffs(diffsBySide) {
  if (!diffsBySide.base || !diffsBySide.head) {
    return 0;
  }

  /**
   * @param {ValueDiff} d
   * @returns {string}
   */
  const identity = (d) => JSON.stringify([d.key, d.prop, d.ref, d.val]);
  const inHead = new Set(diffsBySide.head.map(identity));
  const common = new Set(diffsBySide.base.map(identity).filter((id) => inHead.has(id)));
  const base = diffsBySide.base.filter((d) => !common.has(identity(d)));
  const head = diffsBySide.head.filter((d) => !common.has(identity(d)));

  if (![...base, ...head].some((d) => d.level === 'different')) {
    return 0;
  }

  diffsBySide.base = base;
  diffsBySide.head = head;

  return common.size;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
}

/**
 * Worst level first, then by property and element (sorts in place). A side has at most one diff per
 * (element, property), so the order is total and the stored first twelve are deterministic.
 *
 * @param {ValueDiff[]} diffs
 * @returns {ValueDiff[]}
 */
function sortWorstFirst(diffs) {
  return diffs.sort(
    (x, y) =>
      (DIFF_RANK[x.level] ?? UNRANKED) - (DIFF_RANK[y.level] ?? UNRANKED) ||
      compareText(x.prop, y.prop) ||
      compareText(x.key, y.key),
  );
}

/**
 * A side whose text is the input's: equivalent by definition in the same engine.
 *
 * @returns {VariantVerdict}
 */
function sameTextVerdict() {
  return {
    status: 'equivalent',
    reason: 'same-text-as-input',
    diffs: [],
    diffCount: 0,
    levels: {},
    sig: '',
    rejected: { decls: [], selectors: [], preludes: [] },
    hardRejected: 0,
  };
}

/**
 * @param {string} level
 * @returns {string}
 */
function statusOf(level) {
  if (level === 'equal' || level === 'noise') {
    return 'equivalent';
  }

  if (level === 'space-changed' || level === 'near' || level === 'custom-changed') {
    return 'near';
  }

  return 'different';
}

/**
 * @typedef {object} SideContext
 * @property {string} engine
 * @property {Record<string, ValidityProbe>} probe
 * @property {SnapshotVariant} input
 * @property {number} touchedCount
 */

/**
 * The verdict of one side that has an output and is not the input's text.
 *
 * @param {'base' | 'head'} side
 * @param {SnapshotVariant} variant
 * @param {ValueDiff[]} diffs
 * @param {SideContext} context
 * @returns {VariantVerdict}
 */
function sideVerdict(side, variant, diffs, context) {
  let status = statusOf(worstLevel(diffs.map((d) => d.level)));

  if (status === 'equivalent' && context.touchedCount === 0) {
    status = 'no-coverage';
  }

  const rejected = sideRejections(
    context.probe,
    side,
    variant.info || {},
    context.input.info || {},
    context.engine,
  );
  const hardDecls = rejected.decls.filter((d) => !d.fallbackSurvives);
  /** @type {Record<string, number>} */
  const levels = {};

  sortWorstFirst(diffs);

  for (const d of diffs) {
    levels[d.level] = (levels[d.level] || 0) + 1;
  }

  // What differs from the input; equal base/head signatures mean the PR changed the output text
  // without changing how any element computes relative to the input.
  const sig = diffs
    .filter((d) => d.level !== 'noise')
    .map((d) => `${d.key}|${d.prop}|${d.level}|${d.val}`)
    .toSorted()
    .join('\n');

  return {
    status,
    diffs: diffs.slice(0, MAX_DIFFS),
    diffCount: diffs.length,
    levels,
    sig,
    rejected: {
      decls: rejected.decls.slice(0, MAX_REJECTED_DECLS),
      selectors: rejected.selectors.slice(0, MAX_REJECTED_SELECTORS),
      preludes: rejected.preludes.slice(0, MAX_REJECTED_PRELUDES),
    },
    hardRejected: hardDecls.length + rejected.selectors.length + rejected.preludes.length,
  };
}

/**
 * Which (element, property) pairs are different on one side only: head strictly adding to base's
 * differences is a `worsened` case, not a pre-existing one.
 *
 * @param {ValueDiff[]} base
 * @param {ValueDiff[]} head
 * @returns {{ baseOnly: number, headOnly: number }}
 */
function overlapOf(base, head) {
  /**
   * @param {ValueDiff[]} list
   * @returns {Set<string>}
   */
  const keys = (list) =>
    new Set(list.filter((d) => d.level === 'different').map((d) => `${d.key}|${d.prop}`));
  const baseKeys = keys(base);
  const headKeys = keys(head);

  return { baseOnly: baseKeys.difference(headKeys).size, headOnly: headKeys.difference(baseKeys).size };
}

/**
 * Which parts of the input this engine rejects (`decls/selectors/preludes` index lists): engines
 * that disagree here read the input differently.
 *
 * @param {SnapshotVariant} input
 * @returns {{ inputSig: string, inputRejected: boolean }}
 */
function inputRejection(input) {
  const info = input.info || {};
  /**
   * @param {boolean[] | undefined} list
   * @returns {number[]}
   */
  const falseIndexes = (list) => (list || []).flatMap((ok, index) => (ok === false ? [index] : []));
  const parts = [falseIndexes(info.decls), falseIndexes(info.selectors), falseIndexes(info.preludes)];

  return {
    inputSig: parts.map((list) => list.join(',')).join('/'),
    inputRejected: parts.some((list) => list.length > 0),
  };
}

/**
 * @param {Record<string, ValidityProbe>} probe
 * @returns {Set<string>} Unprefixed properties the input, base or head declares.
 */
function declaredProperties(probe) {
  return new Set(
    ['input', 'base', 'head'].flatMap((name) =>
      (probe[name] ? probe[name].decls : []).map((d) => unprefixed(d[0])),
    ),
  );
}

/**
 * @typedef {Omit<EngineEntry, 'version'> & { touched: number, variants: { base: VariantVerdict, head: VariantVerdict } }} SheetEntry
 */

/**
 * @typedef {object} SheetReading What a sheet verdict reads from a job and its raw result.
 * @property {'same-engine' | 'lowering'} mode
 * @property {Record<string, SnapshotVariant>} variants
 * @property {SnapshotVariant} input
 * @property {StyleMap} touched The input's touched values the outputs are compared on.
 * @property {number} touchedCount
 * @property {Record<string, ValidityProbe>} probe
 * @property {Set<string>} declared
 * @property {Set<string>} same Sides whose text is the input's (same-engine only).
 */

/**
 * The classified differences of each side that has an output. Lowering also drops the
 * differences base and head share (see dropSharedDiffs).
 *
 * @param {SheetReading} reading
 * @returns {{ diffsBySide: { base?: ValueDiff[], head?: ValueDiff[] }, shared: number }}
 */
function diffSides({ mode, variants, input, touched, declared, same }) {
  // The engine's own reading of the input is a usable layout reference only when it reads the
  // input like the reference engine (nothing different apart from layout).
  const ownReadsAlike =
    mode === 'lowering' &&
    input.values &&
    !rawDiffs(mode, input, touched, declared).some((d) => d.level === 'different');
  const own = ownReadsAlike ? /** @type {StyleMap} */ (input.values) : null;
  /** @type {{ base?: ValueDiff[], head?: ValueDiff[] }} */
  const diffsBySide = {};

  for (const side of SIDES) {
    if (variants[side]) {
      diffsBySide[side] = same.has(side) ? [] : rawDiffs(mode, variants[side], touched, declared, own);
    }
  }

  return { diffsBySide, shared: mode === 'lowering' ? dropSharedDiffs(diffsBySide) : 0 };
}

/**
 * One engine's verdict on a sheet job.
 *
 * @param {string} engine
 * @param {Pick<SheetJob, 'probe' | 'sameAsInput'> | { probe?: undefined, sameAsInput?: undefined }} job
 * @param {{ variants?: Record<string, SnapshotVariant> }} result The runner's page result.
 * @param {'same-engine' | 'lowering'} mode
 * @param {StyleMap | null} [refTouched] Lowering: the reference engine's input `touched`.
 * @returns {SheetEntry}
 */
export function sheetVerdict(engine, job, result, mode, refTouched) {
  const variants = result.variants || {};
  /** @type {SnapshotVariant} */
  const input = variants.input || {};
  const touched = mode === 'same-engine' ? input.touched || {} : refTouched || {};
  const probe = job.probe || {};
  /** @type {SheetReading} */
  const reading = {
    mode,
    variants,
    input,
    touched,
    touchedCount: Object.values(touched).reduce((count, values) => count + Object.keys(values).length, 0),
    probe,
    declared: declaredProperties(probe),
    // A side whose text is the input's behaves like it in the same engine. A legacy lane compares
    // with another engine's reading, which the same text can miss.
    same: new Set(mode === 'same-engine' ? job.sameAsInput || [] : []),
  };
  const { diffsBySide, shared } = diffSides(reading);
  /** @type {SideContext} */
  const context = { engine, probe, input, touchedCount: reading.touchedCount };
  /**
   * @param {'base' | 'head'} side
   * @returns {VariantVerdict}
   */
  const verdictOf = (side) => {
    const variant = variants[side];

    if (!variant) {
      return { status: 'unknown', reason: 'no-output' };
    }

    if (reading.same.has(side)) {
      return sameTextVerdict();
    }

    return sideVerdict(side, variant, /** @type {ValueDiff[]} */ (diffsBySide[side]), context);
  };
  /** @type {SheetEntry} */
  const entry = {
    touched: reading.touchedCount,
    variants: { base: verdictOf('base'), head: verdictOf('head') },
  };

  if (mode === 'lowering') {
    entry.shared = shared;
  }

  if (diffsBySide.base && diffsBySide.head) {
    entry.overlap = overlapOf(diffsBySide.base, diffsBySide.head);
  }

  if (mode === 'same-engine') {
    Object.assign(entry, inputRejection(input));
  }

  return entry;
}

/** Parsing-job outcomes (runner/page/property.cjs) -> statuses. Unknown outcomes are `unknown`. */
const PROPERTY_STATUS = /** @type {Record<string, string>} */ ({
  pass: 'equivalent',
  'contextual-match': 'equivalent',
  'computed-difference': 'different',
  'valid-became-invalid': 'different',
  'invalid-became-valid': 'different',
  'fallback-changed': 'different',
  'shorthand-reset-changed': 'different',
  'context-required': 'unknown',
  'unsupported-input': 'unknown',
  'both-unsupported': 'unknown',
  'baseline-unsupported-property': 'unknown',
  'no-output': 'unknown',
});

/**
 * One engine's verdict on a parsing job. When the engine itself mishandles the input (`baseline`),
 * only a definite `different` survives; everything else is `unknown`.
 *
 * @param {PropertyResult} result
 * @returns {Omit<EngineEntry, 'version'>}
 */
export function propertyVerdict(result) {
  /** @type {Record<string, VariantVerdict>} */
  const variants = {};

  for (const side of SIDES) {
    const outcome = result.variants ? result.variants[side] : null;

    if (!outcome) {
      variants[side] = { status: 'unknown' };
      continue;
    }

    let status = PROPERTY_STATUS[outcome.status] || 'unknown';

    if (result.baseline && status !== 'different') {
      status = 'unknown';
    }

    variants[side] = { status, detail: outcome };
  }

  return {
    baseline: result.baseline || null,
    variants: { base: variants.base, head: variants.head },
    inputSig: result.baseline ? result.baseline.status : 'ok',
  };
}

/**
 * Why a legacy engine does not judge a lowering case, or null when it does.
 *
 * @param {EngineResult} row
 * @param {OracleCase | Record<string, never>} oracleCase
 * @param {StyleMap | null | undefined} refTouched
 * @returns {string | null}
 */
function skipReason(row, oracleCase, refTouched) {
  const targets = 'targets' in oracleCase ? oracleCase.targets : undefined;
  const target = targets ? targets[ENGINE_TARGET[row.engine]] : undefined;

  if (target === undefined) {
    return 'engine-not-in-targets';
  }

  if (encode(row.version) < target) {
    return 'engine-older-than-targets';
  }

  if (!refTouched) {
    return 'no-reference';
  }

  return null;
}

/**
 * One engine's entry for one job.
 *
 * @param {string} role `reference` or `legacy`.
 * @param {EngineResult} row The runner's result row.
 * @param {Job} job
 * @param {OracleCase | Record<string, never>} oracleCase `{}` when the case is unknown.
 * @param {StyleMap | null | undefined} refTouched The reference engine's input `touched` (lowering).
 * @returns {EngineEntry}
 */
export function engineEntry(role, row, job, oracleCase, refTouched) {
  const version = row.version;

  if (row.error) {
    return { version, error: row.error, variants: { base: { status: 'error' }, head: { status: 'error' } } };
  }

  const result = /** @type {SnapshotResult & PropertyResult} */ (row.result);

  if (job.kind === 'property') {
    return { version, ...propertyVerdict(result) };
  }

  if (role === 'reference') {
    return { version, ...sheetVerdict(row.engine, job, result, 'same-engine') };
  }

  const skipped = skipReason(row, oracleCase, refTouched);

  if (skipped) {
    return { version, skipped };
  }

  return { version, ...sheetVerdict(row.engine, job, result, 'lowering', refTouched) };
}
