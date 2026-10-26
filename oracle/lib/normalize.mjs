/**
 * Computed-value comparison with explicit, documented tolerances.
 *
 * Stage: oracle (analysis image, compare.mjs). Two computed values of one property are compared
 * token by token (tokens.mjs): text must match up to whitespace, numbers within the numeric
 * tolerance, colors within the color tolerances (colors.mjs). The result is a level (`equal`,
 * `noise`, `space-changed`, `custom-changed`, `near`, `different`) and the per-token evidence.
 * Deterministic: the same two strings always produce the same classification.
 */
import { compareColors } from './colors.mjs';
import { tokenize } from './tokens.mjs';
import { LEVEL_RANK, TOLERANCE, roundMetric } from './tolerance.mjs';

/** @import { ValueComparison } from './types.mjs' */
/** @import { Token } from './tokens.mjs' */

/** Per-token details kept in a comparison. */
const MAX_DETAILS = 4;

/** Properties whose value can hold gradients (or images made of them). */
export const GRADIENT_PROPS = new Set([
  'background-image',
  'mask-image',
  '-webkit-mask-image',
  'border-image-source',
  'list-style-image',
  'content',
  'mask-border-source',
  '-webkit-mask-box-image-source',
]);

/**
 * @param {string} text
 * @returns {string}
 */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ');
}

/**
 * Compare two numbers of the same unit.
 *
 * @param {Extract<Token, { t: 'num' }>} x
 * @param {Extract<Token, { t: 'num' }>} y
 * @returns {ValueComparison}
 */
function compareNumbers(x, y) {
  if (x.unit !== y.unit) {
    return { level: 'different', reason: 'unit' };
  }

  const delta = Math.abs(x.v - y.v);
  const tolerance = Math.max(
    TOLERANCE.numberAbs,
    TOLERANCE.numberRel * Math.max(Math.abs(x.v), Math.abs(y.v)),
  );

  if (delta === 0) {
    return { level: 'equal' };
  }

  if (delta <= tolerance) {
    return { level: 'noise', delta: roundMetric(delta) };
  }

  return { level: 'different', reason: 'number', delta: roundMetric(delta) };
}

/**
 * Compare two tokens at the same position.
 *
 * @param {Token} x
 * @param {Token} y
 * @param {'same-engine' | 'lowering'} mode
 * @returns {ValueComparison}
 */
function compareTokens(x, y, mode) {
  if (x.t !== y.t) {
    return { level: 'different', reason: 'token-kind' };
  }

  if (x.t === 'text') {
    return collapseWhitespace(x.v) === collapseWhitespace(String(y.v))
      ? { level: 'equal' }
      : { level: 'different', reason: 'text' };
  }

  if (x.t === 'num') {
    return compareNumbers(x, /** @type {Extract<Token, { t: 'num' }>} */ (y));
  }

  return compareColors(x.v, String(y.v), mode);
}

/**
 * Unregistered custom properties compute to their token stream. A rewrite there (e.g. a color
 * lowered inside color-mix()) is visible to JS and style() queries but not to rendering, which the
 * consuming properties are compared for separately: such a change is `custom-changed`.
 *
 * @param {string} a
 * @param {string} b
 * @param {'same-engine' | 'lowering'} mode
 * @returns {ValueComparison}
 */
function compareCustomProperty(a, b, mode) {
  if (a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()) {
    return { level: 'noise' };
  }

  const inner = compareValues('x-custom-inner', a, b, mode);

  return inner.level === 'different' ? { level: 'custom-changed', details: inner.details || [inner] } : inner;
}

/**
 * Compare two token lists of equal length: the worst token comparison decides.
 *
 * @param {string} prop
 * @param {Token[]} tokensA
 * @param {Token[]} tokensB
 * @param {'same-engine' | 'lowering'} mode
 * @returns {ValueComparison}
 */
function compareTokenLists(prop, tokensA, tokensB, mode) {
  /** @type {ValueComparison} */
  let worst = { level: 'equal' };
  /** @type {ValueComparison[]} */
  const details = [];

  for (const [index, x] of tokensA.entries()) {
    let result = compareTokens(x, tokensB[index], mode);

    // Gradients interpolate in sRGB only when every stop is a legacy color, else in OKLab
    // (css-images-4 #color-interpolation): a legacy/modern switch changes the rendering.
    if (
      mode === 'same-engine' &&
      GRADIENT_PROPS.has(prop) &&
      (result.level === 'space-changed' || result.spaceChanged)
    ) {
      result = { ...result, level: 'different', reason: 'gradient-interpolation-space-changed' };
    }

    if (result.level !== 'equal') {
      details.push(result);
    }

    if (LEVEL_RANK[result.level] > LEVEL_RANK[worst.level]) {
      worst = result;
    }
  }

  return { level: worst.level, details: details.slice(0, MAX_DETAILS) };
}

/**
 * Compare two computed values of one property.
 *
 * @param {string} prop
 * @param {string | null | undefined} a The reference value.
 * @param {string | null | undefined} b
 * @param {'same-engine' | 'lowering'} [mode] See compareColors.
 * @returns {ValueComparison}
 */
export function compareValues(prop, a, b, mode = 'same-engine') {
  if (a === b) {
    return { level: 'equal' };
  }

  const missing = a === null || a === undefined || b === null || b === undefined;

  if (prop.startsWith('--') && missing) {
    return { level: 'custom-changed', reason: 'custom-property-added-or-removed' };
  }

  if (missing) {
    return { level: 'different', reason: 'missing' };
  }

  if (prop.startsWith('--')) {
    return compareCustomProperty(a, b, mode);
  }

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  // A color is one token however it is spelled (`color(srgb …)` versus `rgb(…)`), so a different
  // token count is a different structure.
  if (tokensA.length !== tokensB.length) {
    return { level: 'different', reason: 'shape' };
  }

  return compareTokenLists(prop, tokensA, tokensB, mode);
}
