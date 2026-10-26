/**
 * Drive the JSONL adapter binary (`bin/<side>-adapter`, built from adapter/lcr_adapter.rs).
 *
 * Stage: corpus (every case through both builds), oracle driver and show (pretty-printing an
 * output). Reads nothing from the run directory; the caller writes the responses.
 *
 * Protocol: one JSON request per line on stdin, one JSON response per line on stdout. A worker
 * keeps one adapter process and sends it one request at a time. When the adapter crashes (a stack
 * overflow or an abort takes the process down), stops answering, or prints something that is not
 * JSON, the request gets a synthetic failure response and the next request starts a fresh process.
 *
 * Invariants:
 * - Determinism: responses are keyed by request id and returned sorted by id, so the output does
 *   not depend on the number of workers or on scheduling.
 * - The failure texts (`adapter stdin closed`, `no response within <t>s`, `adapter exited (<code>);
 *   stack overflow or abort`, the first 500 characters of a non-JSON line) end up in
 *   outputs-*.jsonl and corpus.json, so they keep the spelling existing runs have, with Python's
 *   number formatting (`10.0s`, `-6`, `None`).
 */
import { existsSync } from 'node:fs';

import { LcrError } from '../core/errors.js';
import { log } from '../core/log.js';
import { halfTheCpus, LineProcess } from '../core/proc.js';
import { pySlice, pyStr, pyTruthy } from '../core/py.js';
import { compareCodePoints, dumps, loads, pyFloat } from '../core/pyjson.js';

/** @import { AdapterRequest, AdapterResponse } from '../types.js' */
/** @import { PyNumber } from '../core/pyjson.js' */

/**
 * Seconds a request may take unless it carries its own `_timeout`. A float: it is written into
 * stage files as `10.0`.
 */
export const DEFAULT_TIMEOUT = pyFloat(10);

/** At most this many adapter processes per call, however many CPUs there are. */
const MAX_WORKERS = 8;
/** How long to wait for a crashed or killed adapter to report its exit status. */
const EXIT_WAIT_MS = 5000;
/** A non-JSON line is kept in the response up to this many characters. */
const PROTOCOL_ERROR_CHARS = 500;
/** Progress is logged only for batches at least this large, every this many responses. */
const PROGRESS_MIN_TOTAL = 2000;
const PROGRESS_EVERY = 5000;
const MS_PER_SECOND = 1000;

/**
 * A request as the caller builds it: the adapter fields plus an `id`, and optionally host-side
 * keys starting with `_` (`_timeout` in seconds), which are never sent.
 *
 * @typedef {AdapterRequest & { id: string }} IdentifiedRequest
 */

/**
 * One adapter process at a time, restarted after a failure. Dispose of it (`await using`) to kill
 * the last process.
 */
export class AdapterProcess {
  /**
   * @param {string} binary
   * @param {PyNumber} [timeout] Seconds per request (default 10.0).
   */
  constructor(binary, timeout = DEFAULT_TIMEOUT) {
    this.binary = binary;
    this.timeout = timeout;
    /** @type {LineProcess | null} */
    this.process = null;
    /** How many times the adapter was restarted after a failure. */
    this.restarts = 0;
    /**
     * Why a process could not be started (its spawn `error` event).
     *
     * @type {WeakMap<LineProcess, Error>}
     */
    this.startErrors = new WeakMap();
  }

  /**
   * Send one request and wait for its response (or the synthetic failure).
   *
   * @param {Partial<IdentifiedRequest> & Record<string, unknown>} request
   * @returns {Promise<Record<string, unknown>>}
   */
  async request(request) {
    const timeout = pyTruthy(request._timeout) ? /** @type {PyNumber} */ (request._timeout) : this.timeout;
    const id = request.id ?? null;
    const adapter = this.running();

    if (!adapter.writeLine(dumps(withoutHostKeys(request), { ensureAscii: false }))) {
      return this.fail(id, 'crash', 'adapter stdin closed');
    }

    const line = await adapter.readLine(Number(timeout) * MS_PER_SECOND);

    if (line === 'timeout') {
      return this.fail(id, 'timeout', `no response within ${pyStr(timeout)}s`);
    }

    if (line === null) {
      this.throwIfNotStarted(adapter);

      const code = await exitStatus(adapter);

      return this.fail(id, 'crash', `adapter exited (${pyStr(code)}); stack overflow or abort`);
    }

    try {
      return /** @type {Record<string, unknown>} */ (loads(line));
    } catch {
      // The error keeps the line as read, with its line break (as `\n`) if it had one: the stored
      // protocol errors of existing runs are spelled that way.
      const text = adapter.lastLineTerminated ? `${line}\n` : line;

      return this.fail(id, 'protocol', pySlice(text, 0, PROTOCOL_ERROR_CHARS));
    }
  }

  /**
   * The live process, started if there is none or the last one exited.
   *
   * @returns {LineProcess}
   */
  running() {
    const child = this.process?.child;

    if (!this.process || child?.exitCode !== null || child?.signalCode !== null) {
      const adapter = new LineProcess([this.binary], { env: { RUST_BACKTRACE: '0' } });

      adapter.child.once('error', (error) => this.startErrors.set(adapter, error));
      this.process = adapter;
    }

    return this.process;
  }

  /**
   * A binary that cannot be executed (not executable, wrong format) never answers: fail the whole
   * batch at once instead of recording a crash for every request.
   *
   * @param {LineProcess} adapter
   * @returns {void}
   */
  throwIfNotStarted(adapter) {
    const error = this.startErrors.get(adapter);

    if (error) {
      throw new LcrError(`cannot run the adapter ${this.binary}: ${error.message}`, {
        remedy: 'rebuild it with `lcr build`',
        cause: error,
      });
    }
  }

  /**
   * Drop the process after a failure and answer with a failure response.
   *
   * @param {unknown} id
   * @param {string} stage
   * @param {string} error
   * @returns {Promise<Record<string, unknown>>}
   */
  async fail(id, stage, error) {
    await this.close();
    this.restarts++;

    return { id, ok: false, stage, error };
  }

  /**
   * Kill the process, if any (waiting at most a few seconds for it to go).
   *
   * @returns {Promise<void>}
   */
  async close() {
    const adapter = this.process;

    this.process = null;

    // A process that never started never exits either: there is nothing to wait for.
    if (adapter && !this.startErrors.has(adapter)) {
      await withTimeout(adapter.kill(), EXIT_WAIT_MS, null);
    }
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

/**
 * The request as sent: host-side keys (`_timeout`) removed, the rest in insertion order.
 *
 * @param {Record<string, unknown>} request
 * @returns {Record<string, unknown>}
 */
function withoutHostKeys(request) {
  return Object.fromEntries(Object.entries(request).filter(([key]) => !key.startsWith('_')));
}

/**
 * Python's returncode of an adapter whose stdout closed, or null if it does not exit in time.
 *
 * @param {LineProcess} adapter
 * @returns {Promise<number | null>}
 */
function exitStatus(adapter) {
  return withTimeout(adapter.exited, EXIT_WAIT_MS, null);
}

/**
 * What `promise` resolves to, or `fallback` once `ms` milliseconds passed without it.
 *
 * @template T, F
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {F} fallback
 * @returns {Promise<T | F>}
 */
async function withTimeout(promise, ms, fallback) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });

  try {
    return /** @type {T | F} */ (await Promise.race([promise, expired]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {object} RunRequestsOptions
 * @property {number | null} [workers] Default: half the CPUs, at most 8.
 * @property {PyNumber} [timeout] Seconds per request (a request's `_timeout` overrides it); default
 *   10.0. A Python float: pass `pyFloat(n)` for a whole number, as it appears in timeout messages.
 * @property {string} [label] Progress label for large batches.
 */

/**
 * Send every request to `binary`; resolve to id -> response, sorted by id. Every response carries
 * its request's id, whatever the adapter answered.
 *
 * @param {string} binary
 * @param {readonly (IdentifiedRequest | Record<string, unknown> & { id: string })[]} requests
 * @param {RunRequestsOptions} [options]
 * @returns {Promise<Record<string, AdapterResponse>>}
 */
export async function runRequests(binary, requests, { workers, timeout = DEFAULT_TIMEOUT, label = '' } = {}) {
  if (!existsSync(binary)) {
    throw new LcrError(`adapter binary missing: ${binary} (run \`lcr build\` first)`);
  }

  const count = pyTruthy(workers) ? /** @type {number} */ (workers) : defaultWorkers();
  /** @type {Map<string, Record<string, unknown>>} */
  const results = new Map();
  const progress = { done: 0, total: requests.length, label };
  // Round-robin split: neighbouring requests (often similar in size) go to different workers.
  const chunks = Array.from({ length: count }, (_, index) =>
    requests.filter((_request, position) => position % count === index),
  );

  await Promise.all(chunks.map((chunk) => runChunk(binary, chunk, timeout, results, progress)));

  const sorted = [...results.entries()].sort(([left], [right]) => compareCodePoints(left, right));

  // Case ids always start with a source prefix (`t-`, `p-`, …), never look like array indices, so
  // a plain object keeps this order.
  return /** @type {Record<string, AdapterResponse>} */ (Object.fromEntries(sorted));
}

/**
 * Workers when the caller does not say: half the CPUs, between 1 and `MAX_WORKERS`.
 *
 * @returns {number}
 */
function defaultWorkers() {
  return halfTheCpus({ min: 1, max: MAX_WORKERS });
}

/**
 * One worker: its own adapter process, its requests in order.
 *
 * @param {string} binary
 * @param {readonly (Record<string, unknown> & { id: string })[]} chunk
 * @param {PyNumber} timeout
 * @param {Map<string, Record<string, unknown>>} results
 * @param {{ done: number, total: number, label: string }} progress
 * @returns {Promise<void>}
 */
async function runChunk(binary, chunk, timeout, results, progress) {
  await using adapter = new AdapterProcess(binary, timeout);

  for (const request of chunk) {
    const response = await adapter.request(request);

    response.id = request.id;
    results.set(request.id, response);
    progress.done++;

    if (progress.total >= PROGRESS_MIN_TOTAL && progress.done % PROGRESS_EVERY === 0) {
      log(`${progress.label} ${progress.done}/${progress.total}`);
    }
  }
}
