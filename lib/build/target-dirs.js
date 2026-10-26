/**
 * The cargo target directories under `<cache>/targets/`, and how a run resets the ones untrusted
 * code builds into.
 *
 * Stage: build (`base`, `head`, `base-nowarn`, `head-nowarn`, `js-base`, `js-head`) and perf
 * (`base-release`, `head-release`).
 *
 * Invariants:
 * - Base targets are shared by every run: base is upstream code, so what it leaves there can be
 *   trusted by the next run, and warm incremental builds keep reviews fast.
 * - A head target is never shared: before each run builds into it, it is replaced by a copy of
 *   its base counterpart (`seedTarget`), so nothing a reviewed pull request's build scripts or
 *   tests wrote there reaches another run, while head still starts from warm dependencies.
 * - The copy is copy-on-write where the filesystem can (`cp --reflink=auto`, which falls back to
 *   a plain copy by itself; `fs.cpSync` with `COPYFILE_FICLONE` where `cp` lacks the option), and
 *   it keeps timestamps: cargo compares them, and the head tree is touched after the copy, so its
 *   workspace crates always rebuild.
 * - Each directory has a lock (`<name>.lock`, lock.js). A seed holds the head lock and, while it
 *   copies, the base lock, so it never copies a base that a concurrent run is half-way through
 *   building.
 */
import { cpSync, constants, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { acquireLock } from '../core/lock.js';
import { run } from '../core/proc.js';

/** @import { FileLock } from '../core/lock.js' */

/** Copying a target directory takes seconds with reflinks, minutes without; never hours. */
const COPY_TIMEOUT_MS = 30 * 60_000;

/**
 * The head target directories of each build stage and the base ones they start from.
 */
export const SEEDS = Object.freeze({
  build: Object.freeze([
    ['base', 'head'],
    ['base-nowarn', 'head-nowarn'],
  ]),
  release: Object.freeze([['base-release', 'head-release']]),
  js: Object.freeze([['js-base', 'js-head']]),
});

/**
 * `<cache>/targets/<name>`.
 *
 * @param {string} cache
 * @param {string} name
 * @returns {string}
 */
export function targetDir(cache, name) {
  return join(cache, 'targets', name);
}

/**
 * Wait for and take the lock of a target directory (`<cache>/targets/<name>.lock`).
 *
 * @param {string} cache
 * @param {string} name `base` and `head` also cover their `-nowarn` directories.
 * @returns {Promise<FileLock>}
 */
export function lockTarget(cache, name) {
  return acquireLock(join(cache, 'targets', `${name}.lock`));
}

/**
 * Replace the target directory `to` with a copy of `from` (empty when `from` does not exist
 * yet). The caller holds the locks of both.
 *
 * @param {string} from
 * @param {string} to
 * @param {{ copy?: (from: string, to: string) => Promise<boolean> }} [options] `copy` (tests
 *   replace it) copies a directory to a path that does not exist yet and says whether it could.
 * @returns {Promise<void>}
 */
export async function seedTarget(from, to, { copy = reflinkCopy } = {}) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });

  if (!existsSync(from)) {
    mkdirSync(to, { recursive: true });

    return;
  }

  if (!(await copy(from, to))) {
    // `cp` without GNU options (macOS, BusyBox) left nothing or half a copy behind.
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
}

/**
 * `cp -a --reflink=auto`: a few hundred milliseconds for a warm Lightning CSS target on btrfs or
 * XFS, where `fs.cpSync` takes seconds for its per-file calls.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<boolean>}
 */
async function reflinkCopy(from, to) {
  try {
    const result = await run(['cp', '-a', '--reflink=auto', from, to], {
      check: false,
      timeoutMs: COPY_TIMEOUT_MS,
    });

    return result.code === 0;
  } catch {
    // No `cp` at all: the fallback copies.
    return false;
  }
}

/**
 * Seed every head directory of a stage from its base counterpart. The caller holds the head
 * locks; each base lock is held while its directory is copied.
 *
 * @param {string} cache
 * @param {readonly (readonly string[])[]} pairs `[base, head]` names (`SEEDS.*`).
 * @param {{ baseLock: string }} lock The lock name that covers the base directories.
 * @returns {Promise<void>}
 */
export async function seedTargets(cache, pairs, { baseLock }) {
  await using _base = await lockTarget(cache, baseLock);

  for (const [base, head] of pairs) {
    await seedTarget(targetDir(cache, base), targetDir(cache, head));
  }
}
