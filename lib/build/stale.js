/**
 * Stale-build detection for the perf stage: timing two release binaries is only meaningful when
 * they are actually base and head. A shared release target directory reused without a rebuild
 * gives byte-identical binaries, or binaries that print the base output where the adapters
 * differ; then perf records a `skip_reason` instead of vacuous timings.
 *
 * Stage: perf. Reads corpus/deltas.jsonl and corpus/cases.jsonl; runs the release CLI on a few
 * delta inputs (in a throwaway directory under the cache), in a sandbox container
 * (release-cli.js) unless `LCR_BUILD=host`.
 *
 * Invariant: the smoke inputs are a deterministic selection (sorted by case id, first 20), and
 * only cases the CLI reproduces exactly (`--minify`, no targets or other options) are used.
 */
import { mkdtempDisposable } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { iterJsonl, universalNewlines } from '../core/files.js';
import { cacheDir } from '../core/paths.js';
import { compareCodePoints, pyTruthy } from '../core/py.js';
import { runCliPlan } from './release-cli.js';

/** @import { AdapterRequest, CorpusCase, Delta, Side } from '../types.js' */

/** Request keys the release CLI's `--minify` reproduces; any other non-empty option disqualifies. */
const SMOKE_KEYS = new Set(['kind', 'css', 'minify', 'compact', 'filename']);
/** How many delta cases are tried. */
const SMOKE_LIMIT = 20;
/** One CLI run on one small input; anything slower is a hang, not work. */
const CLI_TIMEOUT_MS = 60_000;
/** Every smoke run of both binaries, plus container start-up. */
const PLAN_TIMEOUT_MS = 2 * SMOKE_LIMIT * CLI_TIMEOUT_MS + 5 * 60_000;

/**
 * CSS of delta cases the release CLI reproduces on which the base and head adapters print
 * different code.
 *
 * @param {string} runDir
 * @param {{ limit?: number }} [options] How many inputs at most (default 20).
 * @returns {string[]}
 */
export function smokeInputs(runDir, { limit = SMOKE_LIMIT } = {}) {
  /** @type {Set<string>} */
  const deltas = new Set();

  for (const row of iterJsonl(join(runDir, 'corpus', 'deltas.jsonl'))) {
    const { id, base, head } = /** @type {Delta} */ (row);

    if (base.ok && head.ok && (base.code ?? null) !== (head.code ?? null)) {
      deltas.add(id);
    }
  }

  /** @type {Pick<CorpusCase, 'id' | 'request'>[]} */
  const cases = [];

  for (const row of iterJsonl(join(runDir, 'corpus', 'cases.jsonl'))) {
    const corpusCase = /** @type {Pick<CorpusCase, 'id' | 'request'>} */ (row);

    if (deltas.has(corpusCase.id)) {
      cases.push(corpusCase);
    }
  }

  return cases
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .filter(({ request }) => cliReproduces(request))
    .map(({ request }) => /** @type {string} */ (request.css))
    .slice(0, limit);
}

/**
 * A compact, minified sheet request without targets or other options.
 *
 * @param {AdapterRequest} request
 * @returns {boolean}
 */
function cliReproduces(request) {
  const options = /** @type {Record<string, unknown>} */ (request);
  const extra = Object.keys(options).filter((key) => pyTruthy(options[key]) && !SMOKE_KEYS.has(key));

  return (
    request.kind === 'sheet' &&
    pyTruthy(request.minify) &&
    pyTruthy(request.compact) &&
    pyTruthy(request.css) &&
    extra.length === 0
  );
}

/**
 * `[base, head]` release CLI `--minify` output per input, up to the first input they print
 * differently. Inputs either binary fails on (or hangs on) are skipped.
 *
 * @param {Record<Side, string>} binaries
 * @param {readonly string[]} inputs
 * @param {{ host: boolean, channel: string }} where Where the binaries run (release-cli.js).
 * @returns {Promise<[base: string, head: string][]>}
 */
export async function smokeOutputs(binaries, inputs, where) {
  /** @type {[string, string][]} */
  const pairs = [];

  if (inputs.length === 0) {
    return pairs;
  }

  await using scratch = await mkdtempDisposable(join(cacheDir(), 'perf-smoke-'));
  const paths = inputs.map((css, index) => {
    const path = join(scratch.path, `${index}.css`);

    writeFileSync(path, css);

    return path;
  });
  const plan = { kind: /** @type {const} */ ('output'), binaries, inputs: paths, timeoutMs: CLI_TIMEOUT_MS };
  const { outputs } = /** @type {{ outputs: Record<Side, string | null>[] }} */ (
    await runCliPlan(plan, { ...where, timeoutMs: PLAN_TIMEOUT_MS })
  );

  for (const { base, head } of outputs) {
    if (base === null || head === null) {
      continue;
    }

    const pair = /** @type {[string, string]} */ ([universalNewlines(base), universalNewlines(head)]);

    pairs.push(pair);

    if (pair[0] !== pair[1]) {
      break;
    }
  }

  return pairs;
}

/**
 * @typedef {object} StaleEvidence
 * @property {Uint8Array} base The base release binary.
 * @property {Uint8Array} head The head release binary.
 * @property {Iterable<string>} files Changed paths (prepare.json `files`).
 * @property {readonly [string, string][]} smoke `smokeOutputs`.
 */

/**
 * Why the timings would be vacuous, or null: byte-identical release binaries although the diff
 * changes src/, or release binaries that print the same code where the adapters differ.
 *
 * @param {StaleEvidence} evidence
 * @returns {string | null}
 */
export function staleReason({ base, head, files, smoke }) {
  const changed = [...files].filter((file) => file.startsWith('src/'));

  if (Buffer.from(base).equals(head) && changed.length > 0) {
    return (
      `base and head release binaries are byte-identical although the diff changes ${changed.length} file(s) ` +
      'under src/; stale build or test-only change, so nothing was measured'
    );
  }

  if (smoke.length > 0 && smoke.every(([baseOutput, headOutput]) => baseOutput === headOutput)) {
    return (
      `base and head release binaries print the same output on ${smoke.length} delta case(s) where the ` +
      'adapters differ; stale build, so nothing was measured'
    );
  }

  return null;
}
