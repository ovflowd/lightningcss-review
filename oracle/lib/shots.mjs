/**
 * Screenshot comparison: base and head against the input, per engine.
 *
 * Stage: oracle (analysis image, compare.mjs). The engine runner stores a short hash of each PNG
 * in the result row and the PNG itself under `--shots`. Identical hashes are identical renderings;
 * otherwise the images are decoded and anti-aliasing noise is allowed before calling it a visual
 * difference. Without pngjs or the PNG files, a hash mismatch is a difference.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { shotFile } from '../runner/shots.cjs';

/** @import { DecodedPng } from 'pngjs' */

/** A channel may differ by this much (of 255) and still be noise. */
const CHANNEL_NOISE = 3;
/** Share of pixels allowed to exceed the channel noise. */
const NOISY_PIXEL_SHARE = 0.001;
/** RGBA. */
const BYTES_PER_PIXEL = 4;

/** pngjs, or null when the image lacks it (then every mismatch is `pixel-different`). */
const PNG = loadPng();

/** @returns {{ sync: { read(buffer: Uint8Array): DecodedPng } } | null} */
function loadPng() {
  try {
    return createRequire(import.meta.url)('pngjs').PNG;
  } catch {
    return null;
  }
}

// Same naming as the engine runner: `/` in ids never becomes a directory.
export { shotFile };

/**
 * Whether two decoded images differ beyond anti-aliasing noise.
 *
 * @param {DecodedPng} a
 * @param {DecodedPng} b
 * @returns {boolean}
 */
export function imagesDiffer(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return true;
  }

  let noisy = 0;

  for (let i = 0; i < a.data.length; i += BYTES_PER_PIXEL) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
      Math.abs(a.data[i + 3] - b.data[i + 3]),
    );

    if (delta > CHANNEL_NOISE) {
      noisy++;
    }
  }

  const share = noisy / (a.width * a.height);

  // An empty image gives NaN, which is not "within tolerance": different.
  return !(share <= NOISY_PIXEL_SHARE);
}

/**
 * Compare the PNGs of a variant and the reference variant of one job and engine.
 *
 * @param {string | null} dir The screenshots directory.
 * @param {string} id
 * @param {string} engine
 * @param {string} variant
 * @param {string} reference
 * @returns {'pixel-near' | 'pixel-different'}
 */
export function pixelCompare(dir, id, engine, variant, reference) {
  if (!PNG || !dir) {
    return 'pixel-different';
  }

  try {
    const a = PNG.sync.read(readFileSync(shotFile(dir, id, engine, reference)));
    const b = PNG.sync.read(readFileSync(shotFile(dir, id, engine, variant)));

    return imagesDiffer(a, b) ? 'pixel-different' : 'pixel-near';
  } catch {
    return 'pixel-different';
  }
}

/**
 * The visual verdict of base and head (null for a side without screenshots).
 *
 * @param {Record<string, string>} shots Variant -> hash, from the result row.
 * @param {string | null} dir
 * @param {string} id
 * @param {string} engine
 * @returns {{ base: string | null, head: string | null }}
 */
export function judgeShots(shots, dir, id, engine) {
  /**
   * @param {string} variant
   * @returns {string | null}
   */
  const judge = (variant) => {
    if (!shots[variant] || !shots.input) {
      return null;
    }

    return shots[variant] === shots.input
      ? 'pixel-identical'
      : pixelCompare(dir, id, engine, variant, 'input');
  };

  return { base: judge('base'), head: judge('head') };
}
