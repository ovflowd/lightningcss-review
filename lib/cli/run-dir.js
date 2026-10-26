/**
 * Resolve the run a command works on.
 *
 * Stage: CLI. Every command that works on a run takes it explicitly: a run id, a PR number (its
 * newest run) or `latest`. Nothing falls back to an implicit "last run", because concurrent
 * reviews share `runs/LATEST`; whenever the id was not spelled out, the resolved id is logged.
 *
 * A run id is joined to `<cache>/runs` the way pathlib joins (an absolute path is taken as is,
 * `..` stays, a trailing slash goes), because the run-stage commands print the resolved path.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { log } from '../core/log.js';
import { joinPath } from '../core/pathlib.js';
import { runsDir } from '../core/paths.js';
import { pyIsdigit } from '../core/py-number.js';
import { pyStrip } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';

/**
 * The run directory for `value`: a run id, a PR number or `latest`.
 *
 * @param {string | undefined | null} value
 * @returns {string} `<cache>/runs/<run id>`
 */
export function resolveRun(value) {
  const runs = runsDir();

  if (!value) {
    throw new LcrError('pass a run id, a PR number or `latest`');
  }

  const id = value === 'latest' ? latestRunId(runs) : value;

  if (pyIsdigit(id)) {
    return newestRunOfPr(runs, id);
  }

  const path = joinPath(runs, id);

  if (!existsSync(path)) {
    throw new LcrError(`unknown run ${id}`);
  }

  return path;
}

/**
 * @param {string} runs
 * @returns {string}
 */
function latestRunId(runs) {
  const latest = join(runs, 'LATEST');

  if (!existsSync(latest)) {
    throw new LcrError('no runs yet; start with `lcr prepare <PR>`');
  }

  const id = pyStrip(readFileSync(latest, 'utf8'));

  log(`latest -> ${id}`);

  return id;
}

/**
 * The most recently modified `pr<N>-*` run (ties broken by name).
 *
 * @param {string} runs
 * @param {string} pr
 * @returns {string}
 */
function newestRunOfPr(runs, pr) {
  const prefix = `pr${pr}-`;
  const names = existsSync(runs) ? readdirSync(runs).filter((name) => name.startsWith(prefix)) : [];

  if (names.length === 0) {
    throw new LcrError(`no run for PR #${pr}; run \`lcr prepare ${pr}\``);
  }

  const ordered = names
    .map((name) => ({ name, mtime: statSync(join(runs, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || compareCodePoints(a.name, b.name));
  const newest = /** @type {{ name: string }} */ (ordered.at(-1)).name;

  if (ordered.length > 1) {
    log(`PR #${pr} -> ${newest} (newest of ${ordered.length} runs)`);
  }

  return join(runs, newest);
}
