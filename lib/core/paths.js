/**
 * Where things live: the skill checkout, its config, the cache and the Lightning CSS clone.
 *
 * Stage: shared. Every stage resolves paths through here so that `LCR_CACHE`, `XDG_CACHE_HOME` and
 * `LCR_REPO` mean the same thing everywhere.
 *
 * Invariants:
 * - The cache is never under /tmp by default: run directories hold gigabytes of build trees and
 *   must survive a reboot. `LCR_CACHE` is used as given (not resolved), as in py-final, and paths
 *   are spelled as pathlib spells them (`..` kept), so the paths printed and stored in
 *   prepare.json keep py-final's spelling.
 * - The Lightning CSS clone is only read (fetch, `git archive`, `git grep`); nothing here writes
 *   to it.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { LcrError } from './errors.js';
import { joinPath, purePath, resolvePath } from './pathlib.js';
import { runSync } from './proc.js';
import { loads } from './pyjson.js';

/** The skill checkout (this repository). Symlinks are resolved, as py-final's `Path.resolve()`. */
export const SKILL_DIR = resolve(import.meta.dirname, '..', '..');

/** `config/` of the skill checkout. */
export const CONFIG_DIR = join(SKILL_DIR, 'config');

/** The GitHub repository under review. */
export const UPSTREAM = 'parcel-bundler/lightningcss';

/** Schema version written into prepare.json, analysis.json and report.json. */
export const SCHEMA_VERSION = 1;

/**
 * The skill version from `VERSION` (report.json and env.json record it).
 *
 * @returns {string}
 */
export function skillVersion() {
  return readFileSync(join(SKILL_DIR, 'VERSION'), 'utf8').trim();
}

/**
 * The cache directory, created if missing: `$LCR_CACHE`, else `$XDG_CACHE_HOME/lightningcss-review`,
 * else `~/.cache/lightningcss-review`.
 *
 * @returns {string}
 */
export function cacheDir() {
  const explicit = process.env.LCR_CACHE;
  const base = process.env.XDG_CACHE_HOME || joinPath(homedir(), '.cache');
  const path = explicit ? purePath(explicit) : joinPath(base, 'lightningcss-review');

  mkdirSync(path, { recursive: true });

  return path;
}

/**
 * `<cache>/runs`, where every run directory lives (not created here).
 *
 * @returns {string}
 */
export function runsDir() {
  return joinPath(cacheDir(), 'runs');
}

/**
 * The Lightning CSS clone the harness fetches into and reads from. Order: `$LCR_REPO` (with `~`
 * expanded and symbolic links followed, as py-final's `Path(...).expanduser().resolve()`), the
 * checkout the command runs in, `~/GitHub/lightningcss`, else a clone managed in the cache.
 *
 * @returns {string}
 */
export function repoDir() {
  const explicit = process.env.LCR_REPO;

  if (explicit) {
    return resolvePath(explicit.replace(/^~(?=\/|$)/, homedir()));
  }

  const top = gitTopLevel();

  if (top && isLightningCssCheckout(top)) {
    return top;
  }

  const conventional = join(homedir(), 'GitHub', 'lightningcss');

  return isLightningCssCheckout(conventional) ? conventional : joinPath(cacheDir(), 'lightningcss');
}

/**
 * The repository root of the current directory, or null outside a checkout (or without git).
 * Synchronous on purpose: it is a millisecond query and every git call needs it.
 *
 * @returns {string | null}
 */
function gitTopLevel() {
  try {
    const result = runSync(['git', 'rev-parse', '--show-toplevel'], { check: false });

    return result.code === 0 ? result.stdout.trim() || null : null;
  } catch (error) {
    // No git on PATH: there is no checkout to find.
    if (error instanceof LcrError) {
      return null;
    }

    throw error;
  }
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isLightningCssCheckout(path) {
  const cargo = join(path, 'Cargo.toml');

  if (!existsSync(cargo) || !statSync(cargo).isFile()) {
    return false;
  }

  return readFileSync(cargo, 'utf8').includes('name = "lightningcss"');
}

/**
 * A file from `config/`, parsed with Python's JSON rules.
 *
 * @param {string} name e.g. `engines.json`.
 * @returns {unknown} Cast it to the config typedef (`EnginesConfig`, `ModesConfig`, …).
 */
export function loadConfig(name) {
  return loads(readFileSync(join(CONFIG_DIR, name), 'utf8'));
}
