/**
 * Running cases through both adapters and comparing the answers: the part of the corpus stage
 * that `lcr corpus` and `lcr probe` share.
 *
 * Stage: corpus. Reads bin/<side>-adapter (built by `lcr build`), which runs in a sandbox
 * container of its side's builder image (adapter/sandbox.js).
 *
 * Invariants:
 * - Base and head get byte-identical requests; the adapters run one side after the other, each
 *   with half the CPUs, so per-request timeouts stay comparable between runs.
 * - Outputs are keyed by case id and come back in id order, so worker scheduling never shows.
 * - A delta is a difference of normalized responses (adapter/normalize.js): error locations and
 *   Debug noise do not count.
 */
import { existsSync } from 'node:fs';

import { runRequests } from '../adapter/client.js';
import { sideAdapter } from '../adapter/sandbox.js';
import { normalizeResponse } from '../adapter/normalize.js';
import { MIB } from '../core/disk.js';
import { LcrError } from '../core/errors.js';
import { log } from '../core/log.js';
import { joinPath } from '../core/pathlib.js';
import { halfTheCpus } from '../core/proc.js';
import { pyLen } from '../core/py.js';
import { sameJson } from './assess.js';
import { timeoutOption } from './idempotency.js';

/** @import { AdapterResponse, CorpusCase, Delta } from '../types.js' */
/** @import { Outputs } from './assess.js' */

/** Fixed headroom of a corpus pass on top of the per-case estimate. */
const DISK_HEADROOM_BYTES = 100 * MIB;
/** Bytes per case besides its CSS (ids, options, JSON framing). */
const DISK_BYTES_PER_CASE = 200;
/** A case's CSS is written about four times: input, two outputs, a delta. */
const DISK_COPIES = 4;
/** Adapter workers per side, at least: a slow request must not stall the whole side. */
const MIN_WORKERS = 2;

/**
 * Bytes a corpus pass writes: inputs, both outputs and deltas, plus headroom.
 *
 * @param {readonly CorpusCase[]} cases
 * @returns {number}
 */
export function diskNeed(cases) {
  let total = 0;

  for (const corpusCase of cases) {
    total += pyLen(corpusCase.request.css || '') + DISK_BYTES_PER_CASE;
  }

  return DISK_HEADROOM_BYTES + DISK_COPIES * total;
}

/**
 * Send every case through the base adapter, then through the head adapter.
 *
 * @param {string} runDir
 * @param {readonly CorpusCase[]} cases
 * @param {string} label Progress label.
 * @returns {Promise<[base: Outputs, head: Outputs]>}
 */
export async function runAll(runDir, cases, label) {
  const baseBinary = joinPath(runDir, 'bin/base-adapter');
  const headBinary = joinPath(runDir, 'bin/head-adapter');

  if (!existsSync(baseBinary) || !existsSync(headBinary)) {
    throw new LcrError('adapters missing; `lcr build` must succeed for both sides first');
  }

  const requests = cases.map((corpusCase) => ({
    id: corpusCase.id,
    ...corpusCase.request,
    ...timeoutOption(corpusCase),
  }));
  const workers = halfTheCpus({ min: MIN_WORKERS });

  log(`${label}: ${requests.length} requests x 2 builds`);

  const base = await runRequests(await sideAdapter(runDir, 'base'), requests, {
    workers,
    label: `${label}/base`,
  });
  const head = await runRequests(await sideAdapter(runDir, 'head'), requests, {
    workers,
    label: `${label}/head`,
  });

  return [base, head];
}

/**
 * The `deltas.jsonl` row of a case, or null when base and head behave the same.
 *
 * @param {CorpusCase} corpusCase
 * @param {Partial<AdapterResponse>} base
 * @param {Partial<AdapterResponse>} head
 * @returns {Delta | null}
 */
export function deltaOf(corpusCase, base, head) {
  const normalizedBase = normalizeResponse(base);
  const normalizedHead = normalizeResponse(head);

  if (sameJson(normalizedBase, normalizedHead)) {
    return null;
  }

  return {
    id: corpusCase.id,
    source: /** @type {Delta['source']} */ (corpusCase.source),
    base: normalizedBase,
    head: normalizedHead,
  };
}

/**
 * `outputs-<side>.jsonl` rows, in id order.
 *
 * @param {Outputs} outputs
 * @returns {Iterable<AdapterResponse>}
 */
export function outputRows(outputs) {
  return Object.entries(outputs)
    .values()
    .map(([id, response]) => ({ ...response, id }));
}
