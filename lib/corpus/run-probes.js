/**
 * `lcr probe`: re-run only the PR probes (after the agent wrote <run>/probes) and merge them into
 * the corpus files, without repeating the whole corpus pass.
 *
 * Stage: corpus (between `lcr corpus` and `lcr oracle`, any number of times).
 *
 * Reads: <run>/probes, corpus.json and the corpus/*.jsonl files of the last pass.
 * Writes: the same files, plus oracle.json and oracle/verdicts.jsonl when probes were deleted
 * (through the oracle driver's `dropCases`). Prints one block per PR probe on stdout.
 *
 * Invariants:
 * - The PR probe set is rebuilt from the files every time: cases of deleted or renamed probes
 *   (and their mutations) leave every stage file, so nothing stale reaches the oracle or report.
 * - Everything not owned by PR probes (tuples, curated probes, WPT, real-world) is kept as is and
 *   keeps its position in the files; the fresh cases are appended.
 */
import { preflightDisk } from '../core/disk.js';
import { LcrError } from '../core/errors.js';
import { iterJsonl, readJson, writeJson, writeJsonl } from '../core/files.js';
import { log, print } from '../core/log.js';
import { joinPath } from '../core/pathlib.js';
import { compareCodePoints, pyFormat, pyLen, pyRstrip, pySorted, pyTruthy } from '../core/py.js';
import { dropCases } from '../oracle-driver/oracle.js';
import {
  countBySource,
  fillIdempotent,
  flagOnly,
  mergeFlagOnly,
  probeEntry,
  recordCrashes,
  responseOf,
} from './assess.js';
import { deltaOf, diskNeed, outputRows, runAll } from './differential.js';
import { idempotency, idempotencySplit } from './idempotency.js';
import { mutationCases } from './mutations.js';
import { probeCases, probeFilesHash } from './sources.js';

/** @import { CorpusCase, CorpusSummary, Delta, IdempotencyEntry, ProbeResult, RobustnessEntry, Side } from '../types.js' */
/** @import { Outputs } from './assess.js' */

/** How `probeTable` shows an assertion result. */
const MARKS = new Map([
  [true, 'pass'],
  [false, 'FAIL'],
  [null, '-'],
]);

/**
 * @param {boolean | null | undefined} result
 * @returns {string}
 */
function mark(result) {
  return /** @type {string} */ (MARKS.get(result ?? null));
}

/**
 * PR probe cases and their mutations (mutation parents are head tuples or PR probes).
 *
 * @param {Map<string, CorpusCase>} cases
 * @returns {Set<string>}
 */
export function prProbeCaseIds(cases) {
  /** @type {Set<string>} */
  const ids = new Set();

  for (const [id, corpusCase] of cases) {
    const prProbe = corpusCase.source === 'probe' && corpusCase.origin === 'pr';
    const prMutation = corpusCase.source === 'mutation' && String(corpusCase.parent ?? '').startsWith('p-');

    if (prProbe || prMutation) {
      ids.add(id);
    }
  }

  return ids;
}

/**
 * The PR probes and their mutations, freshly parsed; problems are logged.
 *
 * @param {string} runDir
 * @returns {{ cases: CorpusCase[], problems: string[] }}
 */
function freshPrCases(runDir) {
  const { cases: probes, problems } = probeCases(runDir);
  const prCases = probes.filter((probeCase) => 'origin' in probeCase && probeCase.origin === 'pr');

  prCases.push(...mutationCases(prCases));

  for (const problem of problems) {
    log(`probe problem: ${problem}`);
  }

  if (!prCases.length) {
    log('no PR probes found in <run>/probes');
  }

  return { cases: prCases, problems };
}

/**
 * Rewrite cases.jsonl and both outputs files: replaced ids out, fresh ones appended.
 *
 * @param {string} runDir
 * @param {readonly CorpusCase[]} prCases
 * @param {Outputs} base
 * @param {Outputs} head
 * @returns {{ stale: string[], replaced: Set<string>, existing: Map<string, CorpusCase> }} Ids that
 *   disappeared, every id rewritten, and the merged cases.
 */
function mergeCaseFiles(runDir, prCases, base, head) {
  const dir = joinPath(runDir, 'corpus');
  /** @type {Map<string, CorpusCase>} */
  const existing = new Map();

  for (const row of iterJsonl(joinPath(dir, 'cases.jsonl'))) {
    const corpusCase = /** @type {CorpusCase} */ (row);

    existing.set(corpusCase.id, corpusCase);
  }

  const newIds = new Set(prCases.map((corpusCase) => corpusCase.id));
  const oldIds = prProbeCaseIds(existing);
  const stale = [...oldIds.difference(newIds)].sort(compareCodePoints);
  const replaced = oldIds.union(newIds);

  for (const id of replaced) {
    existing.delete(id);
  }

  for (const corpusCase of prCases) {
    existing.set(corpusCase.id, corpusCase);
  }

  writeJsonl(joinPath(dir, 'cases.jsonl'), existing.values());

  for (const [name, outputs] of /** @type {const} */ ([
    ['base', base],
    ['head', head],
  ])) {
    const path = joinPath(dir, `outputs-${name}.jsonl`);
    const kept = keyedRows(path, replaced);

    for (const row of outputRows(outputs)) {
      kept.set(row.id, row);
    }

    writeJsonl(path, kept.values());
  }

  return { stale, replaced, existing };
}

/**
 * The rows of a JSONL file by id, without the replaced ones.
 *
 * @param {string} path
 * @param {ReadonlySet<string>} replaced
 * @returns {Map<string, { id: string }>}
 */
function keyedRows(path, replaced) {
  /** @type {Map<string, { id: string }>} */
  const rows = new Map();

  for (const row of iterJsonl(path)) {
    const keyed = /** @type {{ id: string }} */ (row);

    if (!replaced.has(keyed.id)) {
      rows.set(keyed.id, keyed);
    }
  }

  return rows;
}

/**
 * @typedef {object} ProbePass The fresh results of the PR cases merged into the stored ones.
 * @property {Map<string, Delta>} deltas
 * @property {Map<string, ProbeResult>} probes
 * @property {Record<Side, RobustnessEntry[]>} robustness
 * @property {ProbeResult[]} fresh The PR probes' own entries.
 */

/**
 * Judge the fresh PR cases on top of what the last pass stored for everything else.
 *
 * @param {string} runDir
 * @param {CorpusSummary} summary
 * @param {readonly CorpusCase[]} prCases
 * @param {{ base: Outputs, head: Outputs, replaced: ReadonlySet<string> }} context
 * @returns {ProbePass}
 */
function judgePrCases(runDir, summary, prCases, { base, head, replaced }) {
  /** @type {Map<string, Delta>} */
  const deltas = new Map();

  for (const row of iterJsonl(joinPath(runDir, 'corpus', 'deltas.jsonl'))) {
    const delta = /** @type {Delta} */ (row);

    if (!replaced.has(delta.id)) {
      deltas.set(delta.id, delta);
    }
  }

  const probes = new Map(
    summary.probes.filter((entry) => !replaced.has(entry.id)).map((entry) => [entry.id, entry]),
  );
  const storedRobustness = summary.robustness;
  /** @type {Record<Side, RobustnessEntry[]>} */
  const robustness = {
    base: (storedRobustness.base ?? []).filter((row) => !replaced.has(row.id)),
    head: (storedRobustness.head ?? []).filter((row) => !replaced.has(row.id)),
  };
  /** @type {ProbeResult[]} */
  const fresh = [];

  for (const corpusCase of prCases) {
    const baseResponse = responseOf(base, corpusCase.id);
    const headResponse = responseOf(head, corpusCase.id);
    const delta = deltaOf(corpusCase, baseResponse, headResponse);

    if (delta) {
      deltas.set(corpusCase.id, delta);
    }

    if (corpusCase.source === 'probe') {
      const entry = probeEntry(corpusCase, baseResponse, headResponse, delta !== null);

      probes.set(corpusCase.id, entry);
      fresh.push(entry);
    }

    recordCrashes(corpusCase, baseResponse, headResponse, robustness);
  }

  return { deltas, probes, robustness, fresh };
}

/**
 * Stored second-pass results without the replaced cases.
 *
 * @param {Record<string, IdempotencyEntry> | undefined} stored
 * @param {ReadonlySet<string>} replaced
 * @returns {Record<string, IdempotencyEntry>}
 */
function keptIdempotency(stored, replaced) {
  return Object.fromEntries(Object.entries(stored ?? {}).filter(([id]) => !replaced.has(id)));
}

/**
 * @param {Record<string, IdempotencyEntry>} entries
 * @returns {Record<string, IdempotencyEntry>}
 */
function sortedEntries(entries) {
  return Object.fromEntries(pySorted(Object.entries(entries), ([id]) => id));
}

/**
 * Re-run only the PR probes and their mutations, merging into the corpus files; cases of deleted
 * probes leave the corpus and the oracle.
 *
 * @param {string} runDir
 * @returns {Promise<CorpusSummary>}
 */
export async function runProbes(runDir) {
  const summary = /** @type {CorpusSummary | null} */ (readJson(joinPath(runDir, 'corpus.json')));

  if (!summary || !pyTruthy(summary)) {
    throw new LcrError('run `lcr corpus` first');
  }

  const { cases: prCases, problems } = freshPrCases(runDir);

  preflightDisk(runDir, diskNeed(prCases), 'probe');

  const [base, head] = prCases.length ? await runAll(runDir, prCases, 'probes') : [{}, {}];
  const { stale, replaced, existing } = mergeCaseFiles(runDir, prCases, base, head);
  const pass = judgePrCases(runDir, summary, prCases, { base, head, replaced });
  const idem = keptIdempotency(summary.idempotency, replaced);
  const idemBase = keptIdempotency(summary.idempotency_base, replaced);
  const newIdem = await idempotency(runDir, prCases, head, 'head');
  const newIdemBase = await idempotency(runDir, prCases, base, 'base');

  Object.assign(idem, newIdem);
  Object.assign(idemBase, newIdemBase);
  fillIdempotent(pass.fresh, newIdem, newIdemBase);

  summary.robustness = pass.robustness;
  summary.idempotency = sortedEntries(idem);
  summary.idempotency_base = sortedEntries(idemBase);
  [summary.idempotency_failures, summary.idempotency_preexisting] = idempotencySplit(idem, idemBase);
  summary.flag_only = mergeFlagOnly(summary.flag_only ?? {}, flagOnly(prCases, base, head), replaced);
  writeJsonl(joinPath(runDir, 'corpus', 'deltas.jsonl'), pass.deltas.values());
  summary.probes = pySorted(pass.probes.values(), (entry) => entry.id);
  summary.probe_problems = problems;
  summary.probe_files = probeFilesHash(runDir);

  const counts = countBySource(existing.values());

  for (const source of /** @type {const} */ (['probe', 'mutation'])) {
    summary.cases[source] = Object.hasOwn(counts, source) ? counts[source] : 0;
  }

  summary.deltas = countBySource(pass.deltas.values());
  writeJson(joinPath(runDir, 'corpus.json'), summary);
  finish(runDir, { stale, prCases, deltas: pass.deltas, fresh: pass.fresh, newIdem, newIdemBase });

  return summary;
}

/**
 * @typedef {object} ProbeRunResult
 * @property {string[]} stale Ids of deleted or changed PR cases.
 * @property {readonly CorpusCase[]} prCases
 * @property {Map<string, Delta>} deltas
 * @property {ProbeResult[]} fresh
 * @property {Record<string, IdempotencyEntry>} newIdem
 * @property {Record<string, IdempotencyEntry>} newIdemBase
 */

/**
 * Drop stale cases from the oracle files, log, and print the probe table.
 *
 * @param {string} runDir
 * @param {ProbeRunResult} result
 * @returns {void}
 */
function finish(runDir, { stale, prCases, deltas, fresh, newIdem, newIdemBase }) {
  if (stale.length) {
    dropCases(runDir, new Set(stale));
    log(`dropped ${stale.length} case(s) of deleted or changed PR probes`);
  }

  const changed = prCases.filter((corpusCase) => deltas.has(corpusCase.id)).length;

  log(`PR probes: ${prCases.length}; changed: ${changed}`);
  print(
    probeTable(
      pySorted(fresh, (entry) => entry.probe),
      newIdem,
      newIdemBase,
    ),
  );
}

/**
 * One block per PR probe: every assertion on base and head, the re-minification result and any
 * crash. `-` means decided elsewhere (equivalent: the oracle) or not applicable.
 *
 * @param {readonly ProbeResult[]} entries
 * @param {Record<string, IdempotencyEntry> | null} [idem]
 * @param {Record<string, IdempotencyEntry> | null} [idemBase]
 * @returns {string}
 */
export function probeTable(entries, idem = null, idemBase = null) {
  /** @type {[string, string, string, string][]} */
  const rows = [];

  for (const entry of entries) {
    rows.push(...probeRows(entry, idem, idemBase));
  }

  if (!rows.length) {
    return 'PR probes: none';
  }

  /** @type {[string, string, string, string]} */
  const header = ['probe', 'assertion', 'base', 'head'];
  const widths = [0, 1, 2].map((column) => Math.max(...[...rows, header].map((row) => pyLen(row[column]))));
  const changed = entries.filter((entry) => entry.changed).length;
  const lines = [`PR probes: ${entries.length} (changed on head: ${changed})`];

  for (const row of [header, ...rows]) {
    const cells = [0, 1, 2].map((column) => pyFormat(row[column], `<${widths[column]}`));

    lines.push(pyRstrip(`${cells.join('  ')}  ${row[3]}`));
  }

  return lines.join('\n');
}

/**
 * The table rows of one probe; only its first row carries the probe label.
 *
 * @param {ProbeResult} entry
 * @param {Record<string, IdempotencyEntry> | null} idem
 * @param {Record<string, IdempotencyEntry> | null} idemBase
 * @returns {[string, string, string, string][]}
 */
function probeRows(entry, idem, idemBase) {
  /** @type {[string, string, string, string][]} */
  const rows = [];
  const headChecks = entry.assert.head ?? {};
  const baseChecks = entry.assert.base ?? {};
  const names = Object.keys(headChecks);

  for (const name of names) {
    rows.push([
      '',
      name,
      mark(Object.hasOwn(baseChecks, name) ? baseChecks[name] : null),
      mark(headChecks[name]),
    ]);
  }

  if (!names.includes('idempotent')) {
    rows.push(['', '(re-minify stable)', stableMark(idemBase, entry.id), stableMark(idem, entry.id)]);
  }

  const crash = entry.crash ?? {};

  if (Object.keys(crash).length) {
    rows.push(['', 'crash', crash.base ?? '-', crash.head ?? '-']);
  }

  if (rows.length) {
    rows[0][0] = entry.probe + (entry.changed ? '  [changed]' : '');
  }

  return rows;
}

/**
 * @param {Record<string, IdempotencyEntry> | null} data
 * @param {string} id
 * @returns {string}
 */
function stableMark(data, id) {
  return mark(data && Object.hasOwn(data, id) ? data[id].stable : null);
}
