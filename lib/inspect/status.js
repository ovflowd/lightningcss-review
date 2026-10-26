/**
 * `lcr status <run>`: which stages of a run are done, which are stale, and the verdict once the
 * report exists.
 *
 * Stage: inspect (read-only). Reads the stage files, the probe files under <run>/probes and the
 * corpus files' digests. Writes nothing.
 *
 * Staleness: the oracle records digests of the corpus files it judged (oracle.json `inputs`);
 * when they no longer match, the corpus changed after the oracle ran. Runs recorded before
 * oracle.json stored those digests fall back to comparing modification times, so old run
 * directories still get a status. Probe files newer than corpus.json (or a count mismatch) mean
 * `lcr probe` has not seen the latest edits.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { fileSha256, readJson } from '../core/files.js';
import { print } from '../core/log.js';
import { pyGet, pyGetIn, pyOr } from '../core/py-value.js';
import { pyFormat, pyStr, pyTruthy } from '../core/py.js';

/** @import { Analysis, CaseVerdict, CorpusSummary, OracleSummary, ReportFile } from '../types.js' */

/** Width of the stage-name column. */
const NAME_WIDTH = 9;
/** The corpus files whose digests oracle.json records. */
const JUDGED_FILES = ['cases', 'outputs-base', 'outputs-head'];
const NANOSECONDS_PER_SECOND = 1_000_000_000n;

/**
 * Print the stage table of a run.
 *
 * @param {string} runDir
 * @returns {Promise<void>}
 */
export async function status(runDir) {
  print(`run       ${basename(runDir)}`);

  for (const [name, state] of stageRows(runDir)) {
    print(`${pyFormat(name, String(NAME_WIDTH))} ${state}`);
  }

  const report = /** @type {ReportFile | null} */ (readJson(join(runDir, 'report.json')));

  if (report && pyTruthy(report)) {
    const scope = pyTruthy(report.verdict_scope) ? ` (${report.verdict_scope})` : '';

    print(`verdict   ${pyStr(report.verdict)}${scope} ${pyStr(report.counts)}`);
  }
}

/**
 * (stage, state) for every stage of a run, in pipeline order.
 *
 * @param {string} runDir
 * @returns {[string, string][]}
 */
export function stageRows(runDir) {
  const done = (/** @type {string} */ file) => (existsSync(join(runDir, file)) ? 'done' : '-');
  const corpus = /** @type {Partial<CorpusSummary>} */ (pyOr(readJson(join(runDir, 'corpus.json')), {}));

  return [
    ['prepare', done('prepare.json')],
    ['build', done('build.json')],
    ['corpus', done('corpus.json')],
    ['probe', probeState(runDir, corpus)],
    ['oracle', oracleState(runDir, corpus)],
    ['analysis', analysisState(runDir)],
    ['report', done('report.json')],
  ];
}

/**
 * Probe files on disk versus PR probes in the corpus.
 *
 * @param {string} runDir
 * @param {Partial<CorpusSummary>} corpus
 * @returns {string}
 */
function probeState(runDir, corpus) {
  const files = cssFiles(join(runDir, 'probes'));
  const inCorpus = (corpus.probes ?? []).filter((probe) => pyGet(probe, 'origin', null) === 'pr').length;

  if (files.length === 0 && inCorpus === 0) {
    return '-';
  }

  const corpusPath = join(runDir, 'corpus.json');
  const edited = existsSync(corpusPath) && files.some((file) => pyMtime(file) > pyMtime(corpusPath));
  const stale = edited || files.length !== inCorpus ? '; stale: run `lcr probe`' : '';

  return `${files.length} file(s), ${inCorpus} in corpus${stale}`;
}

/**
 * Every entry named `*.css` below a directory, hidden names included, like Python's
 * `rglob("*.css")`, so the count in the status line is the one earlier versions printed; `[]` when
 * the directory does not exist.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function cssFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.css'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Python's `Path.stat().st_mtime`: the modification time as a double, computed the way CPython
 * computes it (`sec + nsec * 1e-9`). Staleness compares these doubles rather than exact
 * nanoseconds, so files written within one rounding step of each other compare as they always
 * have.
 *
 * @param {string} path
 * @returns {number}
 */
function pyMtime(path) {
  const nanoseconds = statSync(path, { bigint: true }).mtimeNs;
  const seconds = nanoseconds / NANOSECONDS_PER_SECOND;

  return Number(seconds) + Number(nanoseconds - seconds * NANOSECONDS_PER_SECOND) * 1e-9;
}

/**
 * Whether the oracle ran, judged the current corpus, and how many cases errored.
 *
 * @param {string} runDir
 * @param {Partial<CorpusSummary>} corpus
 * @returns {string}
 */
function oracleState(runDir, corpus) {
  const oraclePath = join(runDir, 'oracle.json');

  if (!existsSync(oraclePath)) {
    return '-';
  }

  const oracle = /** @type {Partial<OracleSummary>} */ (pyOr(readJson(oraclePath), {}));
  const verdicts = /** @type {Record<string, CaseVerdict[]>} */ (pyOr(pyGet(oracle, 'verdicts', null), {}));
  const errored = Object.values(verdicts).filter((list) =>
    list.some((verdict) => verdict.summary.latest.transition === 'errored'),
  ).length;
  const bits = ['done'];

  if (oracleIsStale(runDir, oracle, corpus)) {
    bits.push('stale: the corpus changed after the oracle ran');
  }

  if (errored) {
    bits.push(`${errored} errored case(s)`);
  }

  return bits.join('; ');
}

/**
 * @param {string} runDir
 * @param {Partial<OracleSummary>} oracle
 * @param {Partial<CorpusSummary>} corpus
 * @returns {boolean}
 */
function oracleIsStale(runDir, oracle, corpus) {
  const recorded = /** @type {Record<string, unknown>} */ (pyOr(pyGet(oracle, 'inputs', null), {}));
  const casesPath = join(runDir, 'corpus', 'cases.jsonl');

  if (!pyTruthy(recorded)) {
    return existsSync(casesPath) && pyMtime(casesPath) > pyMtime(join(runDir, 'oracle.json'));
  }

  /** @type {Record<string, unknown>} */
  const current = Object.fromEntries(
    JUDGED_FILES.map((name) => [name, fileSha256(join(runDir, 'corpus', `${name}.jsonl`))]),
  );

  current.probe_files = pyGet(corpus, 'probe_files', null);

  return Object.entries(current).some(
    ([key, value]) => Object.hasOwn(recorded, key) && recorded[key] !== value,
  );
}

/**
 * @param {string} runDir
 * @returns {string}
 */
function analysisState(runDir) {
  const analysis = /** @type {Partial<Analysis> | null} */ (readJson(join(runDir, 'analysis.json')));

  if (!analysis || !pyTruthy(analysis)) {
    return '-';
  }

  const open = openAnalysisSlots(analysis);

  return open ? `open (${open} slots; refresh with \`lcr worklist\`)` : 'done';
}

/**
 * Slots in analysis.json still waiting for an answer (stale delta slots do not count).
 *
 * @param {Partial<Analysis>} analysis
 * @returns {number}
 */
export function openAnalysisSlots(analysis) {
  const unanswered = pyGet(analysis, 'checklist', []).filter((answer) => !pyTruthy(answer.answer)).length;
  const unclassified = pyGet(analysis, 'deltas', []).filter(
    (delta) => !pyTruthy(delta.classification) && !pyTruthy(delta._stale),
  ).length;
  const intent = pyTruthy(pyGetIn(analysis, 'intent', 'summary')) ? 0 : 1;

  return unanswered + unclassified + intent;
}
