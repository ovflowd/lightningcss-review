/**
 * Stage 5, oracle: run the cases worth checking in real browsers and record their verdicts.
 *
 * Selects the cases (select.js), runs the engine pipeline in containers (pipeline.js), writes
 * oracle.json and the spec cards for the report, and fails the stage when engine jobs errored on
 * probes or on more than a few cases. `--rerun` runs some cases again (after an engine error) and
 * merges their verdicts; `dropCases` removes the cases of deleted PR probes.
 *
 * Reads: corpus files, prepare.json, <cache>/env.json. Writes: oracle/ (cases, jobs, raw results,
 * screenshots, verdicts.jsonl; a re-run uses oracle/rerun/), oracle.json, spec-cards.json.
 *
 * Invariant: oracle.json records fingerprints of the corpus files it judged (`inputs`), so
 * `lcr status` can tell when the corpus changed after the oracle ran.
 */
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { preflightDisk } from '../core/disk.js';
import { LcrError } from '../core/errors.js';
import { iterJsonl, readJson, removePath, writeJson, writeJsonl } from '../core/files.js';
import { log } from '../core/log.js';
import { pyGet } from '../core/py-value.js';
import { pyTruthy } from '../core/py.js';
import { specCards } from '../spec/spec.js';
import { engineEnvironment, oracleDiskNeed, runOracle } from './pipeline.js';
import { selectCases } from './select.js';
import {
  checkErrors,
  logProblems,
  logTransitions,
  matchIds,
  mergeVerdicts,
  oracleInputs,
  pickVerdicts,
} from './verdicts.js';

/** @import { CaseVerdict, OracleSummary } from '../types.js' */

/** Default cap on the cases run (`--max-cases`). */
const DEFAULT_MAX_CASES = 4000;
/** A re-run selects among every candidate, so the cap must not cut any. */
const UNLIMITED_CASES = 10 ** 9;

/**
 * @typedef {object} OracleOptions
 * @property {string | null} [profiles] Comma-separated engine profiles (default: engines.json defaults).
 * @property {number} [maxCases] Cap on selected cases (default 4000).
 * @property {string | null} [rerun] Re-run only these case ids or globs and merge them.
 */

/**
 * Run the oracle stage (or, with `rerun`, re-run some cases).
 *
 * @param {string} runDir
 * @param {OracleOptions} [options]
 * @returns {Promise<Partial<OracleSummary>>} oracle.json; `{}` when there was nothing to verify.
 */
export async function oracle(runDir, { profiles = null, maxCases = DEFAULT_MAX_CASES, rerun = null } = {}) {
  if (rerun) {
    return rerunCases(runDir, { patterns: rerun, profiles });
  }

  const environment = engineEnvironment(profiles);
  const out = freshDirectory(join(runDir, 'oracle'));
  const { cases, stats } = await selectCases(runDir, maxCases);
  const summaryPath = join(runDir, 'oracle.json');

  if (cases.length === 0) {
    writeJson(summaryPath, { stats, verdicts: {}, profiles: {}, inputs: oracleInputs(runDir) });
    log('oracle: nothing to verify');

    return {};
  }

  preflightDisk(out, oracleDiskNeed(cases.length), 'oracle');

  const result = await runOracle(out, cases, environment);
  /** @type {OracleSummary} */
  const summary = { stats, ...result, inputs: oracleInputs(runDir) };

  writeJson(summaryPath, summary);
  await specCards(runDir);
  logTransitions('oracle:', result.verdicts);
  logProblems(result.verdicts);
  checkErrors(result.verdicts);

  return summary;
}

/**
 * Run the oracle again for some cases only and merge their verdicts into oracle.json and
 * oracle/verdicts.jsonl.
 *
 * @param {string} runDir
 * @param {{ patterns: string, profiles: string | null }} options Comma/space-separated case ids or
 *   globs to re-run, and the engine profiles.
 * @returns {Promise<Partial<OracleSummary>>}
 */
async function rerunCases(runDir, { patterns, profiles }) {
  const summaryPath = join(runDir, 'oracle.json');
  const summary = /** @type {Partial<OracleSummary> | null} */ (readJson(summaryPath));

  if (!summary || !pyTruthy(summary)) {
    throw new LcrError('no oracle.json yet', { remedy: 'run `lcr oracle <run>` first' });
  }

  const environment = engineEnvironment(profiles);
  const { cases } = await selectCases(runDir, UNLIMITED_CASES);
  const ids = matchIds(
    patterns,
    cases.map((entry) => entry.id),
  );

  if (ids.length === 0) {
    throw new LcrError(`--rerun ${patterns}: no oracle case matches`, {
      remedy: 'list the case ids with `lcr table <run>`',
    });
  }

  const wanted = new Set(ids);
  const chosen = cases.filter((entry) => wanted.has(entry.id));
  const out = freshDirectory(join(runDir, 'oracle', 'rerun'));

  preflightDisk(out, oracleDiskNeed(chosen.length), 'oracle');

  const result = await runOracle(out, chosen, environment);
  const merged = mergeVerdicts(summary, result, ids);
  const verdictsPath = join(runDir, 'oracle', 'verdicts.jsonl');

  writeJson(summaryPath, merged);
  writeJsonl(verdictsPath, [
    ...iterJsonl(verdictsPath).filter((row) => !wanted.has(/** @type {CaseVerdict} */ (row).case)),
    ...iterJsonl(join(out, 'verdicts.jsonl')),
  ]);

  const rerunVerdicts = pickVerdicts(pyGet(merged, 'verdicts', {}), ids);

  logTransitions(`oracle: re-ran ${ids.length} case(s);`, rerunVerdicts);
  logProblems(rerunVerdicts);
  checkErrors(rerunVerdicts);

  return merged;
}

/**
 * Remove cases (of deleted PR probes) from oracle.json and oracle/verdicts.jsonl.
 *
 * @param {string} runDir
 * @param {ReadonlySet<string>} ids
 * @returns {void}
 */
export function dropCases(runDir, ids) {
  const summaryPath = join(runDir, 'oracle.json');
  const summary = /** @type {Partial<OracleSummary> | null} */ (readJson(summaryPath));
  const keep = (/** @type {[string, unknown]} */ [id]) => !ids.has(id);

  if (summary && pyTruthy(summary)) {
    summary.verdicts = Object.fromEntries(Object.entries(pyGet(summary, 'verdicts', {})).filter(keep));
    summary.dom = Object.fromEntries(Object.entries(pyGet(summary, 'dom', {})).filter(keep));
    writeJson(summaryPath, summary);
  }

  const verdictsPath = join(runDir, 'oracle', 'verdicts.jsonl');

  if (existsSync(verdictsPath)) {
    writeJsonl(
      verdictsPath,
      iterJsonl(verdictsPath)
        .filter((row) => !ids.has(/** @type {CaseVerdict} */ (row).case))
        .toArray(),
    );
  }
}

/**
 * An empty directory at `path` (whatever was there is deleted). A symbolic link is refused rather
 * than replaced: the link may point at data shared with another cache.
 *
 * @param {string} path
 * @returns {string}
 */
export function freshDirectory(path) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new LcrError(`cannot replace ${path}: it is a symbolic link`, {
      remedy: 'remove the link (or point LCR_CACHE at another directory) and run the command again',
    });
  }

  removePath(path);
  mkdirSync(path, { recursive: true });

  return path;
}
