/**
 * The Lightning CSS clone: make sure it exists, fetch master and PR heads into `refs/lcr/*`,
 * resolve what base and head mean for a PR or a local range, and export trees.
 *
 * Stage: prepare. Reads and fetches only; nothing is committed and no branch or working tree of
 * the clone is touched (`refs/lcr/*` are the harness's own refs).
 *
 * Invariant: head is the tree you would get by merging the PR into current master (`git
 * merge-tree --write-tree`, no commit is created). When that conflicts, head falls back to the PR
 * head commit and base to its merge base with master, and the strategy says so.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { removeFile, removePath, universalNewlines } from '../core/files.js';
import { git } from '../core/git.js';
import { log } from '../core/log.js';
import { repoDir, UPSTREAM } from '../core/paths.js';
import { run } from '../core/proc.js';
import { compareCodePoints, pySlice, pySplit, pyStrip } from '../core/py.js';

/** Cloning or fetching Lightning CSS (a few hundred MB on a cold clone). */
const NETWORK_TIMEOUT_MS = 30 * 60_000;
/** `git archive` of one tree and its extraction. */
const EXPORT_TIMEOUT_MS = 10 * 60_000;
const UPSTREAM_URL = `https://github.com/${UPSTREAM}.git`;
/** Commit-id characters in a run id (`pr<N>-h<head>-b<base>`). */
const RUN_ID_SHA_LENGTH = 8;

/**
 * `git -C <clone> <args>` as text, with universal newlines (`\r\n` read as `\n`).
 *
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export async function gitText(args, options = {}) {
  return universalNewlines(await git(args, options));
}

/**
 * The clone, cloned from GitHub when missing. A fork clone works as long as it has an `upstream`
 * remote, which is added when absent.
 *
 * @returns {Promise<string>}
 */
export async function ensureRepo() {
  const repo = repoDir();

  if (!existsSync(join(repo, '.git'))) {
    log(`cloning ${UPSTREAM} into ${repo}`);
    mkdirSync(dirname(repo), { recursive: true });
    await run(['git', 'clone', '--quiet', UPSTREAM_URL, repo], { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  const origin = pyStrip(await gitText(['remote', 'get-url', 'origin']));

  if (!origin.includes(UPSTREAM)) {
    const remotes = pySplit(await gitText(['remote']));

    if (!remotes.includes('upstream')) {
      await git(['remote', 'add', 'upstream', UPSTREAM_URL]);
    }
  }

  return repo;
}

/**
 * The remote that points at parcel-bundler/lightningcss.
 *
 * @returns {Promise<'origin' | 'upstream'>}
 */
export async function upstreamRemote() {
  const origin = pyStrip(await gitText(['remote', 'get-url', 'origin']));

  return origin.includes(UPSTREAM) ? 'origin' : 'upstream';
}

/**
 * `git rev-parse <rev>`.
 *
 * @param {string} rev
 * @returns {Promise<string>}
 */
export async function revParse(rev) {
  return pyStrip(await gitText(['rev-parse', rev]));
}

/**
 * Fetch a ref from the upstream remote into one of the harness's `refs/lcr/*` (forced: PR heads
 * are force-pushed).
 *
 * @param {string} remote
 * @param {{ source: string, destination: string }} refs
 * @returns {Promise<void>}
 */
export async function fetchRef(remote, { source, destination }) {
  await git(['fetch', '--quiet', remote, `+${source}:${destination}`], { timeoutMs: NETWORK_TIMEOUT_MS });
}

/**
 * @typedef {object} Resolved What base and head are for a run.
 * @property {string} base
 * @property {string} prHead
 * @property {string} headTree
 * @property {'merged-into-master' | 'pr-head-vs-merge-base' | 'local-range'} strategy
 * @property {string[]} conflicts Paths that conflict when merging into master.
 */

/**
 * A PR: head is the PR merged into master; on conflicts, the PR head against its merge base.
 *
 * @param {string} master
 * @param {string} prHead
 * @returns {Promise<Resolved>}
 */
export async function resolveMerge(master, prHead) {
  // Not git(): a conflict exits 1, and the exit status is what tells the two cases apart.
  const merge = await run(
    ['git', '-C', repoDir(), 'merge-tree', '--write-tree', '--name-only', master, prHead],
    {
      check: false,
    },
  );
  const output = universalNewlines(merge.stdout);

  if (merge.code === 0) {
    return {
      base: master,
      prHead,
      headTree: pyStrip(output.split('\n')[0]),
      strategy: 'merged-into-master',
      conflicts: [],
    };
  }

  // Output: the tree id, the conflicted paths, a blank line, informational messages.
  const listed = output.split('\n\n')[0].split('\n').slice(1);
  const conflicts = [...new Set(listed.map((line) => pyStrip(line)).filter(Boolean))].sort(compareCodePoints);

  return {
    base: pyStrip(await gitText(['merge-base', master, prHead])),
    prHead,
    headTree: await revParse(`${prHead}^{tree}`),
    strategy: 'pr-head-vs-merge-base',
    conflicts,
  };
}

/**
 * A local `<base>..<head>` range.
 *
 * @param {string} range
 * @returns {Promise<Resolved>}
 */
export async function resolveRange(range) {
  if (!range.includes('..')) {
    throw new LcrError('--range must look like <base>..<head>');
  }

  const separator = range.indexOf('..');
  const base = await revParse(range.slice(0, separator));
  const prHead = await revParse(range.slice(separator + 2));

  return {
    base,
    prHead,
    headTree: await revParse(`${prHead}^{tree}`),
    strategy: 'local-range',
    conflicts: [],
  };
}

/**
 * The run id: `pr<N>-h<head8>-b<base8>` or `range-h<head8>-b<base8>`.
 *
 * @param {number | null} prNumber
 * @param {Resolved} resolved
 * @returns {string}
 */
export function runIdOf(prNumber, resolved) {
  const commits = `h${pySlice(resolved.prHead, 0, RUN_ID_SHA_LENGTH)}-b${pySlice(resolved.base, 0, RUN_ID_SHA_LENGTH)}`;

  return prNumber === null ? `range-${commits}` : `pr${prNumber}-${commits}`;
}

/**
 * Export a tree-ish into `dest` with `git archive` (skipped when `dest` exists: a run's trees
 * never change once exported). Files keep the commit time; build touches its copies.
 *
 * The tree is extracted next to `dest` and renamed into place, so an interrupted export leaves
 * no half-extracted `dest` that a re-run would then skip.
 *
 * @param {string} treeish
 * @param {string} dest
 * @returns {Promise<void>}
 */
export async function exportTree(treeish, dest) {
  if (existsSync(dest)) {
    return;
  }

  const archive = `${dest}.tar`;
  const partial = `${dest}.partial`;

  mkdirSync(dirname(dest), { recursive: true });
  removePath(partial);

  try {
    await git(['archive', '--format=tar', `--output=${archive}`, treeish], { timeoutMs: EXPORT_TIMEOUT_MS });
    mkdirSync(partial);
    await run(['tar', '-x', '-f', archive, '-C', partial, '--no-same-owner'], {
      timeoutMs: EXPORT_TIMEOUT_MS,
    });
    renameSync(partial, dest);
  } finally {
    removeFile(archive);
    removePath(partial);
  }
}
