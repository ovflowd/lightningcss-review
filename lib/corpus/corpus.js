/**
 * Stage 3, corpus: differential runs. Every case goes through the base and the head adapter with
 * identical options; any normalized difference is a behavioral delta. Sources (sources.js):
 * recorded test tuples, curated and PR probes, metamorphic mutations of the PR's own inputs, the
 * WPT property corpus and pinned real-world stylesheets.
 *
 * Reads: prepare.json, build.json, build/<side>/tuples.jsonl, src/<side>/src/targets.rs,
 * bin/<side>-adapter, probe files, the WPT fixtures and real-world files in the cache.
 * Writes: corpus/cases.jsonl, corpus/outputs-{base,head}.jsonl, corpus/deltas.jsonl, corpus.json.
 *
 * Module map: sources.js builds the cases, differential.js runs them through both adapters,
 * assess.js judges the answers, idempotency.js runs the second pass, run-probes.js is `lcr probe`.
 *
 * Invariants:
 * - Base and head get byte-identical requests (differential.js), and every judgment applies the
 *   same rule to both sides.
 * - Every file is written in a deterministic order (cases in source order, outputs by id, lists in
 *   corpus.json sorted), so identical inputs give byte-identical files.
 * - The adapters' answers are taken as they are. Lightning CSS's rule dedupe can give a different
 *   minified output between two runs of the same build (lightningcss#1235, the curated probe
 *   rule-merging/stale-dedupe-key-idempotent; seen with every harness version, mostly on large real-world
 *   sheets), so a single real-world delta, or that probe's, alone is weak evidence.
 */
import { preflightDisk } from '../core/disk.js';
import { LcrError } from '../core/errors.js';
import { readJson, writeJson, writeJsonl } from '../core/files.js';
import { log } from '../core/log.js';
import { joinPath } from '../core/pathlib.js';
import { compareCodePoints, pyRepr, pySorted, pyTruthy } from '../core/py.js';
import {
  classifyTuple,
  countBySource,
  emptyTupleReport,
  fillIdempotent,
  flagOnly,
  pairKey,
  probeEntry,
  recordCrashes,
  rejectedTuples,
  responseOf,
  sortUnmappable,
} from './assess.js';
import { deltaOf, diskNeed, outputRows, runAll } from './differential.js';
import { idempotency, idempotencySplit } from './idempotency.js';
import { mutationCases } from './mutations.js';
import { probeCases, probeFilesHash, realworldCases, tupleCases, wptCases } from './sources.js';

/** @import { AdapterResponse, Build, CorpusCase, CorpusSummary, Delta, Prepare, ProbeResult, RobustnessEntry, Side } from '../types.js' */
/** @import { Outputs, TupleReport } from './assess.js' */
/** @import { TupleCase, TupleStats } from './sources.js' */

/**
 * @typedef {object} CorpusOptions
 * @property {'auto' | 'all' | 'none' | string} [wpt]
 * @property {'auto' | 'all' | 'none' | string} [realworld]
 */

/**
 * Every case of a corpus pass, in the order they are written: tuples, probes, mutations of the
 * PR's own inputs (head-side tuples and PR probes), WPT, real-world.
 *
 * @param {string} runDir
 * @param {Prepare} prep
 * @param {CorpusOptions} options
 * @returns {{ cases: CorpusCase[], tupleCasesList: TupleCase[], stats: TupleStats, problems: string[] }}
 */
function assembleCases(runDir, prep, { wpt = 'auto', realworld = 'auto' }) {
  const { cases: tuples, stats } = tupleCases(runDir, prep);
  const { cases: probes, problems } = probeCases(runDir);
  const wptList = wptCases(wpt);
  const realworldList = realworldCases(realworld);
  const parents = [
    ...tuples.filter((tupleCase) => tupleCase.side === 'head'),
    ...probes.filter((probeCase) => 'origin' in probeCase && probeCase.origin === 'pr'),
  ];
  const mutations = mutationCases(parents);

  return {
    cases: [...tuples, ...probes, ...mutations, ...wptList, ...realworldList],
    tupleCasesList: tuples,
    stats,
    problems,
  };
}

/**
 * @typedef {object} PassResults What one walk over every case collects.
 * @property {Delta[]} deltas
 * @property {Record<Side, RobustnessEntry[]>} robustness
 * @property {TupleReport} tuples
 * @property {ProbeResult[]} probes
 * @property {{ name: string, mode: string, base: number, head: number }[]} size
 */

/**
 * Judge every case: deltas, crashes, tuple buckets, probe assertions, real-world output sizes.
 *
 * @param {readonly CorpusCase[]} cases
 * @param {readonly TupleCase[]} tuples
 * @param {Outputs} base
 * @param {Outputs} head
 * @returns {PassResults}
 */
function judgeCases(cases, tuples, base, head) {
  /** @type {PassResults} */
  const results = {
    deltas: [],
    robustness: { base: [], head: [] },
    tuples: emptyTupleReport(),
    probes: [],
    size: [],
  };
  /** @type {Map<string, TupleCase>} */
  const headByKey = new Map();

  for (const tupleCase of tuples) {
    if (tupleCase.side === 'head') {
      headByKey.set(pairKey(tupleCase), tupleCase);
    }
  }

  for (const corpusCase of cases) {
    const baseResponse = responseOf(base, corpusCase.id);
    const headResponse = responseOf(head, corpusCase.id);
    const delta = deltaOf(corpusCase, baseResponse, headResponse);

    recordCrashes(corpusCase, baseResponse, headResponse, results.robustness);

    if (delta) {
      results.deltas.push(delta);
    }

    judgeBySource(corpusCase, baseResponse, headResponse, { headByKey, changed: delta !== null, results });
  }

  return results;
}

/**
 * The per-source part of `judgeCases`.
 *
 * @param {CorpusCase} corpusCase
 * @param {Partial<AdapterResponse>} base
 * @param {Partial<AdapterResponse>} head
 * @param {{ headByKey: Map<string, TupleCase>, changed: boolean, results: PassResults }} context
 * @returns {void}
 */
function judgeBySource(corpusCase, base, head, { headByKey, changed, results }) {
  if (corpusCase.source === 'tuple') {
    classifyTuple(/** @type {TupleCase} */ (corpusCase), base, head, headByKey, results.tuples);
  } else if (corpusCase.source === 'probe') {
    results.probes.push(probeEntry(corpusCase, base, head, changed));
  } else if (corpusCase.source === 'realworld' && base.ok && head.ok) {
    results.size.push({
      name: corpusCase.name,
      mode: corpusCase.mode,
      base: Buffer.byteLength(/** @type {string} */ (base.code)),
      head: Buffer.byteLength(/** @type {string} */ (head.code)),
    });
  }
}

/**
 * The cases worth a second pass: every probe and mutation, and tuples with a delta.
 *
 * @param {readonly CorpusCase[]} cases
 * @param {readonly Delta[]} deltas
 * @returns {CorpusCase[]}
 */
function idempotencyTargets(cases, deltas) {
  const deltaIds = new Set(deltas.map((delta) => delta.id));

  return cases.filter(
    (corpusCase) =>
      corpusCase.source === 'probe' ||
      corpusCase.source === 'mutation' ||
      (corpusCase.source === 'tuple' && deltaIds.has(corpusCase.id)),
  );
}

/**
 * Write the four JSONL files of a pass.
 *
 * @param {string} runDir
 * @param {readonly CorpusCase[]} cases
 * @param {Outputs} base
 * @param {Outputs} head
 * @param {readonly Delta[]} deltas
 * @returns {void}
 */
function writeCorpusFiles(runDir, cases, base, head, deltas) {
  const dir = joinPath(runDir, 'corpus');

  writeJsonl(
    joinPath(dir, 'cases.jsonl'),
    cases.values().map((corpusCase) => {
      const { tuple: _tuple, ...rest } = /** @type {CorpusCase & { tuple?: unknown }} */ (corpusCase);

      return rest;
    }),
  );
  writeJsonl(joinPath(dir, 'outputs-base.jsonl'), outputRows(base));
  writeJsonl(joinPath(dir, 'outputs-head.jsonl'), outputRows(head));
  writeJsonl(joinPath(dir, 'deltas.jsonl'), deltas);
}

/**
 * Run the corpus stage.
 *
 * @param {string} runDir
 * @param {CorpusOptions} [options]
 * @returns {Promise<CorpusSummary>}
 */
export async function corpus(runDir, options = {}) {
  const prep = /** @type {Prepare | null} */ (readJson(joinPath(runDir, 'prepare.json')));
  const build = /** @type {Build | null} */ (readJson(joinPath(runDir, 'build.json')));

  if (!prep || !pyTruthy(prep) || !build || !pyTruthy(build)) {
    throw new LcrError('run `lcr prepare` and `lcr build` first');
  }

  const { cases, tupleCasesList, stats, problems } = assembleCases(runDir, prep, options);

  preflightDisk(runDir, diskNeed(cases), 'corpus');

  const [base, head] = await runAll(runDir, cases, 'corpus');
  const results = judgeCases(cases, tupleCasesList, base, head);
  const targets = idempotencyTargets(cases, results.deltas);
  const idem = await idempotency(runDir, targets, head, 'head');
  const idemBase = await idempotency(runDir, targets, base, 'base');
  const [failures, preexisting] = idempotencySplit(idem, idemBase);

  fillIdempotent(results.probes, idem, idemBase);

  const unmappable = sortUnmappable([...stats.unmappable_cases, ...rejectedTuples(tupleCasesList, head)]);

  writeCorpusFiles(runDir, cases, base, head, results.deltas);

  /** @type {CorpusSummary} */
  const summary = {
    cases: countBySource(cases),
    deltas: countBySource(results.deltas),
    tuple_stats: {
      ...stats,
      unmappable: unmappable.reduce((total, row) => total + row.count, 0),
      unmappable_helpers: [...new Set(unmappable.map((row) => row.helper))].sort(compareCodePoints),
      unmappable_cases: unmappable,
    },
    tuples: results.tuples,
    robustness: results.robustness,
    idempotency_failures: failures,
    idempotency_preexisting: preexisting,
    idempotency: idem,
    idempotency_base: idemBase,
    flag_only: flagOnly(cases, base, head),
    probes: results.probes,
    probe_problems: problems,
    probe_files: probeFilesHash(runDir),
    size: pySorted(results.size, (row) => [row.name, row.mode]),
  };

  writeJson(joinPath(runDir, 'corpus.json'), summary);
  logSummary(summary);

  return summary;
}

/**
 * The closing progress line of a corpus pass.
 *
 * @param {CorpusSummary} summary
 * @returns {void}
 */
function logSummary(summary) {
  const deltas = Object.keys(summary.deltas).length ? pyRepr(summary.deltas) : 'none';
  const changes = Object.entries(summary.tuples)
    .filter(([, rows]) => rows.length)
    .map(([bucket, rows]) => `${bucket}=${rows.length}`)
    .join(', ');

  log(
    `deltas: ${deltas}; robustness head=${summary.robustness.head.length} ` +
      `base=${summary.robustness.base.length}; tuple changes: ${changes}`,
  );
}
