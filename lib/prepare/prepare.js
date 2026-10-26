/**
 * Stage 1, prepare: resolve a PR (or a local range) to an exact base/head pair, export both trees,
 * and classify the change (areas, changed items, changed tests, blast radius, risk flags, linked
 * issues, overlapping PRs, CI status).
 *
 * Reads: the Lightning CSS clone (fetches into `refs/lcr/*`), GitHub through `gh` (read-only).
 * Writes: runs/<id>/prepare.json, diff.patch, src/base/, src/head/, issues/<n>.json and
 * runs/LATEST.
 *
 * Invariants:
 * - Head is the tree you get by merging the PR into current master (`git merge-tree
 *   --write-tree`, nothing is committed); on conflicts, head is the PR head and base its merge
 *   base (repo.js).
 * - Everything derived from the diff is deterministic and sorted, so the same PR state yields a
 *   byte-identical prepare.json. GitHub context is only fetched for PR runs that are online.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { readPyText, writeJson, writeText } from '../core/files.js';
import { log, logWarning } from '../core/log.js';
import { cacheDir, SCHEMA_VERSION, skillVersion } from '../core/paths.js';
import { compareCodePoints, pySplitlines } from '../core/py.js';
import { changeAreas, testAreaMap } from './areas.js';
import { addedLinesByFile, changedLines, parseHunks } from './diff.js';
import { ciChecks, fetchLinkedIssues, overlappingPrs, prMeta, viewPr } from './github.js';
import { blastRadius } from './radius.js';
import {
  ensureRepo,
  exportTree,
  fetchRef,
  gitText,
  resolveMerge,
  resolveRange,
  revParse,
  runIdOf,
  upstreamRemote,
} from './repo.js';
import { riskFlags } from './risk.js';
import { compatVariants, enclosingItems, testFnsInRanges } from './rust-items.js';

/** @import { ChangedItem, Prepare, Side } from '../types.js' */
/** @import { ChangedLines, FileHunks } from './diff.js' */
/** @import { Resolved } from './repo.js' */
/** @import { GhPr } from './github.js' */

/**
 * @typedef {object} PrepareOptions
 * @property {number | null} [pr] The PR number.
 * @property {string | null} [localRange] `<base>..<head>` instead of a PR.
 * @property {boolean} [offline] Do not fetch; use refs already present (GitHub is still asked
 *   for the PR itself).
 */

/**
 * prepare's working entry of one changed file: prepare.json's `ChangedFile` plus the text of its
 * added and removed lines (used for areas and risk flags, not written).
 *
 * @typedef {{ status: string } & FileHunks & { added_lines: string[], removed_lines: string[] }} WorkingFile
 */

/** Commit-id characters shown in log lines. */
const LOG_SHA_LENGTH = 12;
/** Head first: changed items and tests list head-side entries before base-side ones. */
const SIDES = /** @type {const} */ (['head', 'base']);

/**
 * Run the prepare stage; resolves to the run directory.
 *
 * @param {PrepareOptions} [options]
 * @returns {Promise<string>}
 */
export async function prepare({ pr = null, localRange = null, offline = false } = {}) {
  const repo = await ensureRepo();
  const remote = await upstreamRemote();
  /** @type {Record<string, unknown>} */
  const meta = { schema: SCHEMA_VERSION, skill_version: skillVersion(), repo };

  if (!offline) {
    await fetchRef(remote, { source: 'refs/heads/master', destination: 'refs/lcr/master' });
  }

  const master = await revParse('refs/lcr/master');
  const { resolved, ghPr } = await resolveRun({ pr, localRange, offline, remote, master, meta });
  const runId = runIdOf(pr, resolved);
  const runDir = join(cacheDir(), 'runs', runId);

  mkdirSync(runDir, { recursive: true });
  Object.assign(meta, {
    run_id: runId,
    run_dir: runDir,
    base: resolved.base,
    master,
    head_tree: resolved.headTree,
    strategy: resolved.strategy,
    conflicts: resolved.conflicts,
  });
  log(
    `run ${runId}: base ${shortSha(resolved.base)} head-tree ${shortSha(resolved.headTree)} (${resolved.strategy})`,
  );

  const files = await classifyChange(runDir, resolved, meta);

  if (meta.kind === 'pr' && !offline) {
    await addGithubContext(meta, /** @type {number} */ (pr), ghPr, files, runDir);
  }

  writeJson(join(runDir, 'prepare.json'), /** @type {Prepare} */ (meta));
  writeText(join(cacheDir(), 'runs', 'LATEST'), `${runId}\n`);

  return runDir;
}

/**
 * @typedef {object} ResolveContext
 * @property {number | null} pr
 * @property {string | null} localRange
 * @property {boolean} offline
 * @property {string} remote
 * @property {string} master
 * @property {Record<string, unknown>} meta Receives `kind`, `pr`/`range` and `pr_head`.
 */

/**
 * Base and head of the run, from the PR (fetched, viewed on GitHub, merged into master) or the
 * local range.
 *
 * @param {ResolveContext} context
 * @returns {Promise<{ resolved: Resolved, ghPr: GhPr | null }>}
 */
async function resolveRun({ pr, localRange, offline, remote, master, meta }) {
  if (pr !== null) {
    if (!offline) {
      await fetchRef(remote, { source: `refs/pull/${pr}/head`, destination: `refs/lcr/pr/${pr}/head` });
    }

    const ghPr = await viewPr(pr);
    const prHead = await revParse(`refs/lcr/pr/${pr}/head`);

    const githubHead = ghPr.headRefOid;

    if (githubHead && githubHead !== prHead) {
      logWarning(`fetched head ${shortSha(prHead)} differs from GitHub headRefOid ${shortSha(githubHead)}`);
    }

    const resolved = await resolveMerge(master, prHead);

    Object.assign(meta, { kind: 'pr', pr: prMeta(ghPr), pr_head: prHead });

    return { resolved, ghPr };
  }

  if (localRange) {
    const resolved = await resolveRange(localRange);

    Object.assign(meta, { kind: 'range', range: localRange, pr_head: resolved.prHead });

    return { resolved, ghPr: null };
  }

  throw new LcrError('pass a PR number or --range base..head');
}

/**
 * Write diff.patch, export both trees and fill in everything derived from the diff.
 *
 * @param {string} runDir
 * @param {Resolved} resolved
 * @param {Record<string, unknown>} meta
 * @returns {Promise<Map<string, WorkingFile>>} The changed files (for the GitHub overlap check).
 */
async function classifyChange(runDir, resolved, meta) {
  const { base, headTree } = resolved;
  const patch = await gitText(['diff', '--no-color', '--no-ext-diff', '-M', base, headTree]);

  writeText(join(runDir, 'diff.patch'), patch);

  const hunks = parseHunks(patch);
  const precise = changedLines(patch);
  const nameStatus = await gitText(['diff', '--name-status', '-M', base, headTree]);
  const files = workingFiles(nameStatus, patch, hunks);
  const roots = { head: join(runDir, 'src', 'head'), base: join(runDir, 'src', 'base') };

  await exportTree(base, roots.base);
  await exportTree(headTree, roots.head);

  const fileAreas = changeAreas(files);
  const items = changedItems(files, roots);
  const changedTests = testsChanged(files, precise, roots);
  const areas = sortedUnique([...fileAreas.values()].flat());
  const variants = variantsChanged(files, precise, roots);
  const radius = await blastRadius(headTree, items, { variants });
  const toolchain = join(roots.head, 'rust-toolchain.toml');

  Object.assign(meta, {
    files: Object.fromEntries([...files].sort(byKey).map(([path, info]) => [path, changedFileEntry(info)])),
    file_areas: Object.fromEntries(fileAreas),
    changed_items: items,
    changed_tests: changedTests,
    // Test-derived areas are context for S1 only; the checklists and probes follow the code areas.
    test_areas: testAreas(changedTests),
    areas,
    blast_radius: radius,
    radius_areas: sortedUnique(radius.flatMap((entry) => entry.areas)).filter(
      (area) => !areas.includes(area),
    ),
    compat_variants: variants,
    risk_flags: riskFlags(files, hunks),
    toolchain: existsSync(toolchain) ? readPyText(toolchain, { replace: true }) : null,
  });

  return files;
}

/**
 * Every changed path (from `git diff --name-status`, so renames use the new path) with its hunk
 * ranges and the text of its added and removed lines.
 *
 * @param {string} nameStatus
 * @param {string} patch
 * @param {Map<string, FileHunks>} hunks
 * @returns {Map<string, WorkingFile>}
 */
function workingFiles(nameStatus, patch, hunks) {
  const added = addedLinesByFile(patch);
  const removed = addedLinesByFile(patch, { sign: '-' });
  /** @type {Map<string, WorkingFile>} */
  const files = new Map();

  for (const line of pySplitlines(nameStatus)) {
    const parts = line.split('\t');
    const path = /** @type {string} */ (parts.at(-1));

    files.set(path, {
      status: parts[0],
      ...(hunks.get(path) ?? { head: [], base: [], added: 0, removed: 0 }),
      added_lines: added.get(path) ?? [],
      removed_lines: removed.get(path) ?? [],
    });
  }

  return files;
}

/**
 * prepare.json `files.<path>`: the working entry without the line texts.
 *
 * @param {WorkingFile} info
 * @returns {Omit<WorkingFile, 'added_lines' | 'removed_lines'>}
 */
function changedFileEntry(info) {
  const { added_lines: _added, removed_lines: _removed, ...entry } = info;

  return entry;
}

/**
 * The enclosing items of every changed range of the changed Rust files (src/lib.rs, the tests,
 * excluded), head side first.
 *
 * @param {Map<string, WorkingFile>} files
 * @param {Record<Side, string>} roots
 * @returns {ChangedItem[]}
 */
function changedItems(files, roots) {
  /** @type {ChangedItem[]} */
  const items = [];

  for (const [path, info] of [...files].sort(byKey)) {
    if (!path.endsWith('.rs') || path === 'src/lib.rs') {
      continue;
    }

    for (const side of SIDES) {
      const file = join(roots[side], path);

      if (existsSync(file) && info[side].length > 0) {
        for (const entry of enclosingItems(readPyText(file, { replace: true }), info[side])) {
          items.push({ file: path, side, ...entry });
        }
      }
    }
  }

  return items;
}

/**
 * The `#[test]` functions of src/lib.rs with added (head) or removed (base) lines.
 *
 * @param {Map<string, WorkingFile>} files
 * @param {Map<string, ChangedLines>} precise
 * @param {Record<Side, string>} roots
 * @returns {Partial<Record<Side, string[]>>}
 */
function testsChanged(files, precise, roots) {
  /** @type {Partial<Record<Side, string[]>>} */
  const tests = {};

  if (!files.has('src/lib.rs')) {
    return tests;
  }

  for (const side of SIDES) {
    const lib = join(roots[side], 'src', 'lib.rs');

    if (existsSync(lib)) {
      tests[side] = testFnsInRanges(
        readPyText(lib, { replace: true }),
        precise.get('src/lib.rs')?.[side] ?? [],
      );
    }
  }

  return tests;
}

/**
 * The areas config/areas.json and config/testmap.json give the changed tests.
 *
 * @param {Partial<Record<Side, string[]>>} changedTests
 * @returns {string[]}
 */
function testAreas(changedTests) {
  const map = testAreaMap();

  return sortedUnique(
    Object.values(changedTests)
      .flat()
      .flatMap((test) => map.get(test) ?? []),
  );
}

/**
 * `Feature` variants whose entries changed in the generated src/compat.rs, on either side.
 *
 * @param {Map<string, WorkingFile>} files
 * @param {Map<string, ChangedLines>} precise
 * @param {Record<Side, string>} roots
 * @returns {string[]} Sorted.
 */
function variantsChanged(files, precise, roots) {
  if (!files.has('src/compat.rs')) {
    return [];
  }

  /** @type {string[]} */
  const variants = [];

  for (const side of SIDES) {
    const compat = join(roots[side], 'src', 'compat.rs');

    if (existsSync(compat)) {
      variants.push(
        ...compatVariants(readPyText(compat, { replace: true }), precise.get('src/compat.rs')?.[side] ?? []),
      );
    }
  }

  return sortedUnique(variants);
}

/**
 * Linked issues (written to issues/), overlapping open PRs and CI checks.
 *
 * @param {Record<string, unknown>} meta
 * @param {number} prNumber
 * @param {GhPr | null} ghPr `gh pr view` JSON.
 * @param {Map<string, WorkingFile>} files
 * @param {string} runDir
 * @returns {Promise<void>}
 */
async function addGithubContext(meta, prNumber, ghPr, files, runDir) {
  const issuesDir = join(runDir, 'issues');
  const refs = {
    .../** @type {object} */ (meta.pr),
    number: prNumber,
    closingIssuesReferences: ghPr?.closingIssuesReferences ?? null,
  };

  mkdirSync(issuesDir, { recursive: true });
  meta.linked_issues = await fetchLinkedIssues(refs, issuesDir);
  meta.overlapping_prs = await overlappingPrs(prNumber, files.keys());
  meta.ci_checks = await ciChecks(prNumber);
}

/**
 * A commit or tree id shortened for log lines.
 *
 * @param {string} sha
 * @returns {string}
 */
function shortSha(sha) {
  return sha.slice(0, LOG_SHA_LENGTH);
}

/**
 * The distinct values, sorted by code point.
 *
 * @param {Iterable<string>} values
 * @returns {string[]}
 */
function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodePoints);
}

/**
 * Order `[key, value]` entries by key (code points, as prepare.json's keys are sorted).
 *
 * @param {[string, unknown]} left
 * @param {[string, unknown]} right
 * @returns {number}
 */
function byKey(left, right) {
  return compareCodePoints(left[0], right[0]);
}
