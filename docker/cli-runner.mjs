/**
 * Runs the base and head release CLIs for the perf stage, inside a `builder-sandbox` container
 * (the binaries are built from the reviewed trees), or on the host with `LCR_BUILD=host`.
 *
 * Stage: perf (lib/build/perf.js timings, lib/build/stale.js smoke outputs). Reads a plan as JSON
 * on stdin and writes one JSON result on stdout; mounted read-only at a fixed path, never part of
 * an image.
 *
 * - `{ kind: 'time', binaries, files, repeats, timeoutMs }`: seconds per `--minify
 *   --error-recovery` run, per file and side (null for a failed run); base and head interleaved,
 *   alternating which goes first, so machine drift hits both alike. A run that times out ends
 *   the plan: the result names it in `timedOut`.
 * - `{ kind: 'output', binaries, inputs, timeoutMs }`: each input's `--minify` output per side
 *   (null when the CLI fails or hangs).
 *
 * Timings are taken here, next to the binaries, so starting a container never counts.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/** spawnSync's buffer for a CLI's output: a minified framework sheet is a few megabytes. */
const MAX_OUTPUT_BUFFER = 1 << 30;
const SIDES = /** @type {const} */ (['base', 'head']);
const MS_PER_SECOND = 1000;

/**
 * @typedef {'base' | 'head'} Side
 */

/**
 * @typedef {object} TimePlan
 * @property {'time'} kind
 * @property {Record<Side, string>} binaries
 * @property {[name: string, path: string][]} files
 * @property {number} repeats
 * @property {number} timeoutMs Per run.
 */

/**
 * @typedef {object} OutputPlan
 * @property {'output'} kind
 * @property {Record<Side, string>} binaries
 * @property {string[]} inputs
 * @property {number} timeoutMs Per run.
 */

/**
 * @typedef {object} TimeResult
 * @property {{ name: string, base: (number | null)[], head: (number | null)[] }[]} rows
 * @property {{ side: Side, name: string } | null} timedOut
 */

/**
 * Seconds one `--minify --error-recovery` run takes, NaN when it fails, null when it times out.
 * (`--error-recovery`: several framework sheets carry old hacks such as `*zoom` that strict mode
 * rejects.)
 *
 * @param {string} binary
 * @param {string} css
 * @param {number} timeoutMs
 * @returns {number | null}
 */
export function timeOnce(binary, css, timeoutMs) {
  const start = performance.now();
  const result = spawnSync(binary, ['--minify', '--error-recovery', css], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT_BUFFER,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsed = (performance.now() - start) / MS_PER_SECOND;

  if (/** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === 'ETIMEDOUT') {
    return null;
  }

  return result.status === 0 ? elapsed : Number.NaN;
}

/**
 * Every timing of a plan.
 *
 * @param {TimePlan} plan
 * @returns {TimeResult}
 */
export function timeFiles({ binaries, files, repeats, timeoutMs }) {
  /** @type {TimeResult['rows']} */
  const rows = [];

  for (const [name, path] of files) {
    /** @type {Record<Side, (number | null)[]>} */
    const samples = { base: [], head: [] };

    for (let repeat = 0; repeat < repeats; repeat++) {
      const order = repeat % 2 === 0 ? SIDES : SIDES.toReversed();

      for (const side of order) {
        const seconds = timeOnce(binaries[side], path, timeoutMs);

        if (seconds === null) {
          return { rows, timedOut: { side, name } };
        }

        // JSON has no NaN: a failed run travels as null.
        samples[side].push(Number.isNaN(seconds) ? null : seconds);
      }
    }

    rows.push({ name, ...samples });
  }

  return { rows, timedOut: null };
}

/**
 * The `--minify` output of a CLI for a file, or null when it fails or hangs.
 *
 * @param {string} binary
 * @param {string} css
 * @param {number} timeoutMs
 * @returns {string | null}
 */
export function cliOutput(binary, css, timeoutMs) {
  const result = spawnSync(binary, ['--minify', css], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT_BUFFER,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return result.error || result.status !== 0 ? null : result.stdout;
}

/**
 * Every output of a plan.
 *
 * @param {OutputPlan} plan
 * @returns {{ outputs: Record<Side, string | null>[] }}
 */
export function outputs({ binaries, inputs, timeoutMs }) {
  return {
    outputs: inputs.map((css) => ({
      base: cliOutput(binaries.base, css, timeoutMs),
      head: cliOutput(binaries.head, css, timeoutMs),
    })),
  };
}

/**
 * Run the plan on stdin.
 *
 * @returns {void}
 */
function main() {
  const plan = /** @type {TimePlan | OutputPlan} */ (JSON.parse(readFileSync(0, 'utf8')));
  const result = plan.kind === 'time' ? timeFiles(plan) : outputs(plan);

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  main();
}
