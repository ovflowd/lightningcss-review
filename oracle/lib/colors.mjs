/**
 * Color comparison in OKLab (deltaE OK) with the oracle's tolerances.
 *
 * Stage: oracle (analysis image, compare.mjs). Two engines, or one engine reading two spellings,
 * print the same color differently (`rgb()` versus `color(srgb …)`, rounding of channels); what
 * matters is whether a person could see the difference. Deterministic: the same two strings always
 * give the same classification.
 */
import Color from 'colorjs.io';

import { TOLERANCE, roundMetric } from './tolerance.mjs';

/** @import { ValueComparison } from './types.mjs' */

/** Color functions of the legacy (sRGB, comma-era) family; everything else is modern syntax. */
const LEGACY_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb']);

/**
 * @param {string} text
 * @returns {Color | null}
 */
function parseColor(text) {
  try {
    return new Color(text);
  } catch {
    return null;
  }
}

/**
 * deltaE OK, falling back to the static API, and to Infinity when neither can compute it.
 *
 * @param {Color} a
 * @param {Color} b
 * @returns {number}
 */
function deltaEOK(a, b) {
  try {
    return a.deltaE(b, 'OK');
  } catch {
    try {
      return Color.deltaE(a, b, { method: 'OK' });
    } catch {
      return Infinity;
    }
  }
}

/**
 * @param {Color} color
 * @returns {number}
 */
function alphaOf(color) {
  /** @type {unknown} */
  const alpha = color.alpha;

  if (typeof alpha === 'number') {
    return alpha;
  }

  const boxed = /** @type {{ valueOf?: () => unknown } | null | undefined} */ (alpha);

  return Number(boxed && boxed.valueOf ? boxed.valueOf() : 1);
}

/**
 * Map a color into the sRGB gamut the way CSS does (css-color-4 gamut mapping). A legacy engine
 * can only show sRGB, so a lowered output is compared with the gamut-mapped reference.
 *
 * @param {Color} color
 * @returns {Color}
 */
export function toSrgbGamut(color) {
  try {
    return color.clone().toGamut({ space: 'srgb', method: 'css' });
  } catch {
    try {
      return color.to('srgb').toGamut();
    } catch {
      return color;
    }
  }
}

/**
 * Legacy or modern color syntax (by the function name; hex and named colors are legacy).
 *
 * @param {string} text
 * @returns {'legacy' | 'modern'}
 */
function syntaxFamily(text) {
  const call = /^([a-z-]+)\(/i.exec(text.trim());

  if (!call) {
    return 'legacy';
  }

  return LEGACY_FUNCTIONS.has(call[1].toLowerCase()) ? 'legacy' : 'modern';
}

/**
 * Compare two color strings.
 *
 * - `same-engine`: input and output read by one engine. A `none` component replaced by a number
 *   (or the reverse) changes interpolation, so it is different whatever the distance.
 * - `lowering`: a legacy engine's reading of an output against the reference engine's reading of
 *   the input; the reference is gamut-mapped to sRGB first and 8-bit quantization is tolerated.
 *
 * @param {string} a The reference color.
 * @param {string} b
 * @param {'same-engine' | 'lowering'} [mode]
 * @returns {ValueComparison}
 */
export function compareColors(a, b, mode = 'same-engine') {
  if (a === b) {
    return { level: 'equal' };
  }

  const colorA = parseColor(a);
  const colorB = parseColor(b);

  if (!colorA || !colorB) {
    return { level: 'different', reason: 'unparseable-color' };
  }

  if (/\bnone\b/.test(a) !== /\bnone\b/.test(b) && mode === 'same-engine') {
    return { level: 'different', reason: 'missing-component-changed' };
  }

  const reference = mode === 'lowering' ? toSrgbGamut(colorA) : colorA;
  const deltaE = deltaEOK(reference, colorB);
  const deltaAlpha = Math.abs(alphaOf(colorA) - alphaOf(colorB));
  const spaceChanged = syntaxFamily(a) !== syntaxFamily(b);
  const noise = mode === 'lowering' ? TOLERANCE.deltaEOKNoiseLowering : TOLERANCE.deltaEOKNoise;

  if (deltaE <= noise && deltaAlpha <= TOLERANCE.alphaNoise) {
    return {
      level: spaceChanged && mode === 'same-engine' ? 'space-changed' : 'noise',
      deltaE: roundMetric(deltaE),
      alpha: roundMetric(deltaAlpha),
    };
  }

  if (deltaE <= TOLERANCE.deltaEOKNear && deltaAlpha <= TOLERANCE.alphaNear) {
    return { level: 'near', deltaE: roundMetric(deltaE), alpha: roundMetric(deltaAlpha), spaceChanged };
  }

  return {
    level: 'different',
    deltaE: roundMetric(deltaE),
    alpha: roundMetric(deltaAlpha),
    reason: 'color-distance',
  };
}
