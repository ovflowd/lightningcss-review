/**
 * The tolerances of computed-value comparison, in one place.
 *
 * Stage: oracle (analysis image, compare.mjs). Every threshold that decides between `noise`,
 * `near` and `different` is here with its reason. Changing one changes verdicts: rerun the
 * self-test (`lcr selftest`) after any change.
 */

/** Thresholds for numbers, colors and alpha. */
export const TOLERANCE = Object.freeze({
  /** px-scale absolute noise: LayoutUnit is 1/64px, and engines print floats differently. */
  numberAbs: 0.002,
  /** Relative noise for large numbers. */
  numberRel: 1e-4,
  /** Same engine: invisible rounding of channel values (deltaE OK). */
  deltaEOKNoise: 0.0005,
  /** Lowering to 8-bit sRGB: quantization alone reaches about 0.003. */
  deltaEOKNoiseLowering: 0.005,
  /** CSS gamut mapping's just-noticeable difference; above it a person could see the change. */
  deltaEOKNear: 0.02,
  /** Alpha differences below this are noise. */
  alphaNoise: 0.002,
  /** Alpha differences up to this are near (with a near color). */
  alphaNear: 0.02,
});

/** Distances stored in verdicts keep six decimals. */
const METRIC_SCALE = 1e6;

/**
 * Round a stored distance (deltaE, alpha, numeric delta) to six decimals; non-finite values pass.
 *
 * @param {number} value
 * @returns {number}
 */
export function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * METRIC_SCALE) / METRIC_SCALE : value;
}

/** Severity of each comparison level; the worst level of a value decides. */
export const LEVEL_RANK = /** @type {Record<string, number>} */ ({
  equal: 0,
  noise: 1,
  'space-changed': 2,
  'custom-changed': 2.5,
  near: 3,
  different: 4,
});

/**
 * The worst of several comparison levels (`equal` for none).
 *
 * @param {Iterable<string>} levels
 * @returns {string}
 */
export function worstLevel(levels) {
  let worst = 'equal';

  for (const level of levels) {
    if (LEVEL_RANK[level] > LEVEL_RANK[worst]) {
      worst = level;
    }
  }

  return worst;
}
