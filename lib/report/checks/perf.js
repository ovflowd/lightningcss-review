/**
 * Performance checks P1 (real-world parse+minify time) and P2 (release binary size), from the
 * optional `lcr perf` stage.
 *
 * Stage: report. Reads perf.json. When perf.json says the release binaries look stale
 * (`skip_reason`), nothing was timed and both checks skip with that reason.
 */
import { join } from 'node:path';

import { readJson } from '../../core/files.js';
import { pyFormat, pySorted, pyStr, pyTruthy } from '../../core/py.js';

/**
 * @import { PerfFile } from '../../types.js'
 * @import { EvalContext } from '../context.js'
 */

/** The slowest files P1 lists when it fails. */
const MAX_SLOW_FILES = 6;

/**
 * Evaluate P1 and P2.
 *
 * @param {EvalContext} ctx
 * @returns {void}
 */
export function perfChecks(ctx) {
  const perf = /** @type {PerfFile | null} */ (readJson(join(ctx.runDir, 'perf.json')));
  const { checks } = ctx;

  if (!perf || !pyTruthy(perf)) {
    checks.add('P1', 'SKIP', 'optional: run `lcr perf` for core/hot-path changes');
    checks.add('P2', 'SKIP', 'optional: run `lcr perf`');

    return;
  }

  if (pyTruthy(perf.skip_reason)) {
    const reason = pyStr(perf.skip_reason);

    checks.add('P1', 'SKIP', reason);
    checks.add('P2', 'SKIP', reason);

    return;
  }

  const thresholds = ctx.config.thresholds;
  const slow =
    pyTruthy(perf.total_ratio) &&
    Number(perf.total_ratio) > Number(thresholds.perf_total_ratio) &&
    Number(perf.slower_share) >= Number(thresholds.perf_slower_share);
  const slowest = slow
    ? pySorted(perf.files, (file) => -(pyTruthy(file.ratio) ? Number(file.ratio) : 0))
        .slice(0, MAX_SLOW_FILES)
        .map((file) => `${pyStr(file.name)}: x${pyStr(file.ratio)}`)
    : [];

  checks.add(
    'P1',
    slow ? 'FAIL' : 'PASS',
    `real-world total ${pyStr(perf.total_ms.base)}ms -> ${pyStr(perf.total_ms.head)}ms (x${pyStr(perf.total_ratio)}); ` +
      `${pyFormat(perf.slower_share, '.0%')} of files >5% slower; median of ${pyStr(perf.repeats)}`,
    slowest,
  );

  const grew = Number(perf.binary_ratio) > Number(thresholds.binary_growth_ratio);

  checks.add(
    'P2',
    grew ? 'FAIL' : 'PASS',
    `release CLI ${pyStr(perf.binary_bytes.base)} -> ${pyStr(perf.binary_bytes.head)} bytes (x${pyStr(perf.binary_ratio)})`,
  );
}
