/**
 * `lcr clean`: give disk space back.
 *
 * Stage: CLI, run any time. Three modes:
 * - no run and no `--results`: delete all but the `--keep` most recently modified runs;
 * - `<run>`: delete that run's instrumented build trees (build/<side>/tree) once build.json exists;
 *   the adapters in bin/ and every stage file stay, so later stages still work;
 * - `--results` (with or without a run): delete raw oracle results (`results-*.jsonl`) and
 *   screenshots wherever a `verdicts.jsonl` next to them shows the verdicts were computed.
 *
 * Invariant: nothing a later stage reads is deleted, except whole runs in the first mode.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { MIB } from '../core/disk.js';
import { removePath } from '../core/files.js';
import { log } from '../core/log.js';
import { walkTree } from '../core/pathlib.js';
import { runsDir } from '../core/paths.js';
import { fnmatchcase } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';
import { resolveRun } from './run-dir.js';

const DEFAULT_KEEP = 10;

/**
 * @typedef {object} CleanOptions
 * @property {string | null} [run] A run id, PR number or `latest`.
 * @property {number} [keep] Runs to keep when neither a run nor `results` is given (default 10).
 * @property {boolean} [results]
 */

/**
 * Run `lcr clean`; resolves to the exit status (always 0).
 *
 * @param {CleanOptions} options
 * @returns {Promise<number>}
 */
export async function clean({ run = null, keep = DEFAULT_KEEP, results = false }) {
  // Only a missing run means "delete old runs". An empty one (`lcr clean ''`) never deletes a run:
  // it visits every run and, with neither trees nor results to drop, frees nothing.
  if (run === null && !results) {
    removeOldRuns(keep);

    return 0;
  }

  const targets = run ? [resolveRun(run)] : runDirectories().sort(compareCodePoints);
  let freed = 0;

  for (const runDir of targets) {
    freed += cleanRun(runDir, { buildTrees: Boolean(run), results });
  }

  log(`freed ${Math.floor(freed / MIB)} MiB in ${targets.length} run(s)`);

  return 0;
}

/**
 * Delete every run but the `keep` most recently modified ones (a negative `keep` deletes the
 * oldest -keep runs: slice semantics, which `--keep` has always had).
 *
 * @param {number} keep
 * @returns {void}
 */
function removeOldRuns(keep) {
  const newestFirst = runDirectories()
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);

  for (const { path } of newestFirst.slice(keep)) {
    removePath(path);
    log(`removed ${basename(path)}`);
  }
}

/**
 * Every run directory (files such as `LATEST` are skipped).
 *
 * @returns {string[]}
 */
function runDirectories() {
  const runs = runsDir();

  return readdirSync(runs, { withFileTypes: true })
    .filter((entry) => isDirectory(join(runs, entry.name)))
    .map((entry) => join(runs, entry.name));
}

/**
 * Delete what later stages no longer read from one run; returns the bytes freed.
 *
 * @param {string} runDir
 * @param {{ buildTrees: boolean, results: boolean }} options
 * @returns {number}
 */
export function cleanRun(runDir, { buildTrees, results }) {
  let freed = 0;

  // Build trees are only safe to drop once build.json recorded what the build produced.
  if (buildTrees && existsSync(join(runDir, 'build.json'))) {
    for (const side of ['base', 'head']) {
      freed += drop(join(runDir, 'build', side, 'tree'));
    }
  }

  if (results) {
    for (const oracleDir of verdictDirectories(runDir)) {
      const raw = readdirSync(oracleDir).filter((name) => fnmatchcase(name, 'results-*.jsonl'));

      for (const name of raw.sort(compareCodePoints)) {
        freed += drop(join(oracleDir, name));
      }

      freed += drop(join(oracleDir, 'shots'));
    }
  }

  return freed;
}

/**
 * The directories under `<run>/oracle` (itself included) that hold a verdicts.jsonl. Symbolic links
 * are not followed (Python's `glob('oracle/**\/verdicts.jsonl')` semantics), so results reached
 * through a link elsewhere are never deleted.
 *
 * @param {string} runDir
 * @returns {string[]}
 */
function verdictDirectories(runDir) {
  const oracle = join(runDir, 'oracle');

  if (!isDirectory(oracle)) {
    return [];
  }

  return [...walkTree(oracle)]
    .filter((entry) => entry.name === 'verdicts.jsonl')
    .map((entry) => entry.path)
    .sort(compareCodePoints)
    .map((path) => dirname(path));
}

/**
 * Delete a file or a directory tree; returns the bytes of the regular files it held.
 *
 * @param {string} path
 * @returns {number}
 */
function drop(path) {
  if (!existsSync(path)) {
    return 0;
  }

  const bytes = isDirectory(path) ? treeBytes(path) : statSync(path).size;

  removePath(path);

  return bytes;
}

/**
 * Bytes of the regular files under `dir` (symlinks count their target, as `Path.stat()` does).
 *
 * @param {string} dir
 * @returns {number}
 */
function treeBytes(dir) {
  let bytes = 0;

  for (const { path } of walkTree(dir)) {
    if (existsSync(path) && statSync(path).isFile()) {
      bytes += statSync(path).size;
    }
  }

  return bytes;
}

/**
 * True for a directory or a symlink to one (`Path.is_dir()`).
 *
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}
