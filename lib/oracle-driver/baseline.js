/**
 * `lcr baseline`: every curated probe on current master through the oracle, to know which probes
 * fail on master today. Reports use it as context, and it is the ground truth for triaging probes.
 *
 * Stage: maintenance (outside a review). Prepares and builds a master..master run, runs the
 * corpus on curated probes only (no WPT, no real-world CSS), then the oracle with head output on
 * both sides. Writes the run's oracle files and <cache>/baseline.json.
 *
 * A probe fails on master when one of its assertions fails on head, when it expects idempotency
 * and the second pass differs, or when it expects equivalence and master rejects the input or a
 * browser shows the output differs from the input (`equivalent-legacy` for legacy engines).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { build } from '../build/build.js';
import { readJson, readJsonl, writeJson } from '../core/files.js';
import { log } from '../core/log.js';
import { cacheDir } from '../core/paths.js';
import { pyGet } from '../core/py-value.js';
import { pySlice, pyTruthy } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';
import { corpus } from '../corpus/corpus.js';
import { prepare } from '../prepare/prepare.js';
import { freshDirectory } from './oracle.js';
import { engineEnvironment, runOracle } from './pipeline.js';
import { outputsById } from './select.js';

/** @import { AdapterResponse, Baseline, BaselineProbe, CaseVerdict, CorpusSummary, OracleCase, Prepare, ProbeResult } from '../types.js' */
/** @import { AnyCase } from '../inspect/rows.js' */
/** @import { OracleResult } from './pipeline.js' */

/** The empty range on master: base and head are both master. */
const MASTER_RANGE = 'refs/lcr/master..refs/lcr/master';
/** Characters of the master commit in the log line. */
const SHORT_SHA = 12;

/**
 * Run the baseline and write <cache>/baseline.json.
 *
 * @param {{ profiles?: string | null }} [options]
 * @returns {Promise<string>} The path of baseline.json.
 */
export async function baseline({ profiles = null } = {}) {
  const environment = engineEnvironment(profiles);
  const runDir = await prepare({ pr: null, localRange: MASTER_RANGE, offline: false });

  if (!existsSync(join(runDir, 'bin', 'head-adapter'))) {
    await build(runDir, { js: false, jobs: null });
  }

  const summary = await corpus(runDir, { wpt: 'none', realworld: 'none' });
  const cases = uniqueCases(/** @type {AnyCase[]} */ (readJsonl(join(runDir, 'corpus', 'cases.jsonl'))));
  const head = outputsById(join(runDir, 'corpus', 'outputs-head.jsonl'));
  const oracleCases = probeOracleCases(cases, head);
  const result = await runOracle(freshDirectory(join(runDir, 'oracle')), oracleCases, environment);
  const count = oracleCases.length;

  writeJson(join(runDir, 'oracle.json'), {
    stats: { candidates: count, selected: count, dropped: 0, by_reason: { baseline: count } },
    ...result,
  });

  const probes = baselineProbes(cases, { summary, head, verdicts: result.verdicts });
  const prep = /** @type {Prepare} */ (readJson(join(runDir, 'prepare.json')));
  /** @type {Baseline} */
  const data = { master: prep.base, profiles: result.profiles, probes };
  const path = join(cacheDir(), 'baseline.json');
  const failing = Object.values(probes).filter((probe) => probe.fails_on_master.length > 0).length;

  writeJson(path, data);
  log(
    `baseline: ${Object.keys(probes).length} probes, ${failing} fail on master ` +
      `${pySlice(data.master, 0, SHORT_SHA)} -> ${path}`,
  );

  return path;
}

/**
 * The cases sorted by id, one per id (a repeated id keeps its last row, the rule every existing
 * baseline was built with).
 *
 * @param {readonly AnyCase[]} rows
 * @returns {AnyCase[]}
 */
export function uniqueCases(rows) {
  return [...new Map(rows.map((entry) => [entry.id, entry])).values()].sort((a, b) =>
    compareCodePoints(a.id, b.id),
  );
}

/**
 * The baseline record of every probe case, keyed by probe id.
 *
 * @param {readonly AnyCase[]} cases The run's cases, sorted by id.
 * @param {{ summary: CorpusSummary, head: Map<string, AdapterResponse>, verdicts: OracleResult['verdicts'] }} context
 *   The corpus summary of the master run, head outputs and the oracle's verdicts.
 * @returns {Record<string, BaselineProbe>}
 */
export function baselineProbes(cases, { summary, head, verdicts }) {
  const asserted = new Map(pyGet(summary, 'probes', []).map((row) => [row.id, row]));
  /** @type {Record<string, BaselineProbe>} */
  const probes = {};

  for (const entry of cases.filter((item) => item.source === 'probe')) {
    const probe = /** @type {NonNullable<AnyCase['probe']>} */ (entry.probe);

    probes[probe.id] = probeEntry(entry, { summary, asserted, head, verdicts });
  }

  return probes;
}

/**
 * Oracle cases for the probes master accepts: head output on both sides, so the verdict says
 * whether master's output is equivalent to the input.
 *
 * @param {readonly AnyCase[]} cases Sorted by id.
 * @param {Map<string, AdapterResponse>} head
 * @returns {OracleCase[]}
 */
export function probeOracleCases(cases, head) {
  /** @type {OracleCase[]} */
  const oracleCases = [];

  for (const entry of cases) {
    const request = entry.request;
    const output = head.get(entry.id);

    if (
      entry.source !== 'probe' ||
      pyGet(request, 'kind', null) !== 'sheet' ||
      pyGet(request, 'css_modules', null) !== null ||
      !output ||
      !pyTruthy(output.ok)
    ) {
      continue;
    }

    const code = /** @type {string} */ (output.code);

    oracleCases.push({
      id: entry.id,
      kind: 'sheet',
      sheets: { input: /** @type {string} */ (request.css), base: code, head: code },
      targets: pyGet(request, 'targets', null),
      dom: pyGet(entry.probe ?? {}, 'dom', null),
      visual: false,
    });
  }

  return oracleCases;
}

/**
 * @typedef {object} ProbeContext
 * @property {CorpusSummary} summary The corpus summary of the master run.
 * @property {Map<string, ProbeResult>} asserted Probe assertion results by case id.
 * @property {Map<string, AdapterResponse>} head
 * @property {OracleResult['verdicts']} verdicts
 */

/**
 * The baseline record of one probe and the reasons it fails on master.
 *
 * @param {AnyCase} entry
 * @param {ProbeContext} context
 * @returns {BaselineProbe}
 */
function probeEntry(entry, { summary, asserted, head, verdicts: allVerdicts }) {
  const probe = /** @type {NonNullable<AnyCase['probe']>} */ (entry.probe);
  const asserts = pyGet(pyGet(asserted.get(entry.id) ?? {}, 'assert', {}), 'head', {});
  const verdicts = pyGet(allVerdicts, entry.id, []);
  const output = head.get(entry.id);
  /** @type {BaselineProbe} */
  const record = {
    probe: probe.id,
    area: probe.area,
    known: probe.known,
    path: probe.path,
    expect: probe.expect,
    asserts,
    stage: output && pyTruthy(output.ok) ? null : pyGet(output ?? {}, 'stage', null),
    latest: Object.fromEntries(
      verdicts.map((verdict) => [String(verdict.scheme), verdict.summary.latest.head]),
    ),
    legacy: Object.fromEntries(verdicts.flatMap(legacyHeads)),
    fails_on_master: [],
  };

  record.fails_on_master = failures(record, entry.id, summary);

  return record;
}

/**
 * (`<profile>[~dark]`, head status) for each legacy profile of a verdict.
 *
 * @param {CaseVerdict} verdict
 * @returns {[string, string][]}
 */
function legacyHeads(verdict) {
  const suffix = pyGet(verdict, 'scheme', null) === 'dark' ? '~dark' : '';

  return Object.entries(pyGet(verdict.summary, 'legacy', {})).map(([profile, summary]) => [
    `${profile}${suffix}`,
    summary.head,
  ]);
}

/**
 * Why a probe fails on master, sorted and distinct.
 *
 * @param {BaselineProbe} record
 * @param {string} caseId
 * @param {CorpusSummary} summary
 * @returns {string[]}
 */
function failures(record, caseId, summary) {
  const failed = Object.entries(record.asserts)
    .filter(([, ok]) => ok === false)
    .map(([name]) => name);
  const expect = record.expect;
  const idempotency = pyGet(
    pyGet(summary, 'idempotency', {}),
    caseId,
    /** @type {{ stable?: boolean }} */ ({}),
  );

  if (expect.includes('idempotent') && !pyTruthy(pyGet(idempotency, 'stable', true))) {
    failed.push('idempotent');
  }

  if (expect.includes('equivalent')) {
    // Master rejecting the input means its output cannot be equivalent to it.
    if (pyTruthy(record.stage) && !expect.includes('parse-error')) {
      failed.push('equivalent');
    }

    if (Object.values(record.latest).includes('different')) {
      failed.push('equivalent');
    }

    if (Object.values(record.legacy).includes('different')) {
      failed.push('equivalent-legacy');
    }
  }

  return [...new Set(failed)].sort(compareCodePoints);
}
