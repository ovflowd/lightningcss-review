/**
 * The idempotency pass: feed one side's output back through that side's adapter with the same
 * options. A stable minifier changes nothing the second time.
 *
 * Stage: corpus (probes, mutations and tuples with a delta) and `lcr probe` (PR probes).
 *
 * Reads: bin/<side>-adapter. The results go to corpus.json `idempotency` (head) and
 * `idempotency_base`.
 *
 * Invariant: base and head are re-run symmetrically, so an instability head merely inherited from
 * base is told apart from one the PR introduced (`idempotencySplit`).
 */
import { join } from 'node:path';

import { runRequests } from '../adapter/client.js';
import { compareCodePoints, pyTruthy } from '../core/py.js';
import { responseOf } from './assess.js';

/** @import { AdapterRequest, CorpusCase, IdempotencyEntry, Side } from '../types.js' */
/** @import { PyNumber } from '../core/pyjson.js' */
/** @import { Outputs } from './assess.js' */

/**
 * The second-pass requests: sheet cases whose first pass succeeded, in minify modes, plus print
 * mode probes that assert `idempotent`. CSS modules are skipped because the second pass would
 * hash the already hashed class names again.
 *
 * @param {readonly CorpusCase[]} cases
 * @param {Outputs} outputs The first pass of the same side.
 * @returns {(AdapterRequest & { id: string })[]}
 */
export function idempotencyRequests(cases, outputs) {
  /** @type {(AdapterRequest & { id: string })[]} */
  const requests = [];

  for (const corpusCase of cases) {
    const first = Object.hasOwn(outputs, corpusCase.id) ? outputs[corpusCase.id] : null;
    const request = corpusCase.request;

    if (!first?.ok || request.kind !== 'sheet' || (request.css_modules ?? null) !== null) {
      continue;
    }

    const expects = 'probe' in corpusCase && pyTruthy(corpusCase.probe) ? corpusCase.probe.expect : [];

    if (!request.minify && !expects.includes('idempotent')) {
      continue;
    }

    requests.push({ id: corpusCase.id, ...request, css: first.code, ...timeoutOption(corpusCase) });
  }

  return requests;
}

/**
 * A case's own adapter timeout, as the client's `_timeout` request key. The value stays a Python
 * float (a `PyFloat` for `timeout: 30`): the client prints it in its timeout error, which lands in
 * the outputs and corpus.json as `no response within 30.0s`.
 *
 * @param {CorpusCase} corpusCase
 * @returns {{ _timeout?: PyNumber }}
 */
export function timeoutOption(corpusCase) {
  return pyTruthy(corpusCase.timeout) ? { _timeout: /** @type {PyNumber} */ (corpusCase.timeout) } : {};
}

/**
 * Run the second pass for one side.
 *
 * @param {string} runDir
 * @param {readonly CorpusCase[]} cases
 * @param {Outputs} outputs That side's first pass.
 * @param {Side} [side]
 * @returns {Promise<Record<string, IdempotencyEntry>>} Case id -> whether the output was stable
 *   and what the second pass gave (its code, or its error).
 */
export async function idempotency(runDir, cases, outputs, side = 'head') {
  const requests = idempotencyRequests(cases, outputs);

  if (!requests.length) {
    return {};
  }

  const second = await runRequests(join(runDir, 'bin', `${side}-adapter`), requests, {
    label: `idempotency/${side}`,
  });
  /** @type {Record<string, IdempotencyEntry>} */
  const out = {};

  for (const { id } of requests) {
    const first = outputs[id].code;
    const again = responseOf(second, id);

    out[id] = {
      stable: Boolean(again.ok) && (again.code ?? null) === first,
      second: again.ok ? (again.code ?? null) : (again.error ?? null),
    };
  }

  return out;
}

/**
 * Split head's unstable cases: failures (base was stable, or had no output to re-run) and
 * pre-existing ones (unstable on both sides).
 *
 * @param {Record<string, IdempotencyEntry>} idem
 * @param {Record<string, IdempotencyEntry>} idemBase
 * @returns {[failures: string[], preexisting: string[]]}
 */
export function idempotencySplit(idem, idemBase) {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const preexisting = [];

  for (const [id, entry] of Object.entries(idem)) {
    if (entry.stable) {
      continue;
    }

    const base = Object.hasOwn(idemBase, id) ? idemBase[id] : null;

    (base && !base.stable ? preexisting : failures).push(id);
  }

  return [failures.sort(compareCodePoints), preexisting.sort(compareCodePoints)];
}
