/**
 * What GitHub knows about a PR: its metadata, linked issues, overlapping open PRs and CI status.
 *
 * Stage: prepare. Read-only `gh` calls against parcel-bundler/lightningcss. Writes
 * issues/<n>.json (one per linked issue); the rest lands in prepare.json (`pr`, `linked_issues`,
 * `overlapping_prs`, `ci_checks`).
 *
 * Invariants: lists are sorted (issues by number, overlaps by shared-file count then number,
 * checks by name), so prepare.json does not depend on the order GitHub answers in. A linked issue
 * that cannot be read (it is a PR, or private) is skipped, not an error.
 */
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { universalNewlines, writeJson } from '../core/files.js';
import { UPSTREAM } from '../core/paths.js';
import { run, shellJoin } from '../core/proc.js';
import { pyIntOrRaise } from '../core/py-number.js';
import { pyRe } from '../core/py-re.js';
import { compareCodePoints, pySlice, pyStrip, pyTruthy } from '../core/py.js';
import { loads } from '../core/pyjson.js';

/** @import { CiCheck, LinkedIssue, OverlappingPr, PrMeta } from '../types.js' */

/**
 * @typedef {{ number?: number | null }} IssueRef A `closingIssuesReferences` entry.
 */

/**
 * `gh pr view --json …`: the fields prepare reads.
 *
 * @typedef {object} GhPr
 * @property {number} number
 * @property {string} title
 * @property {{ login?: string | null } | null} [author]
 * @property {string} url
 * @property {string} state
 * @property {boolean | null} [isDraft]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{ name: string }[] | null} [labels]
 * @property {string | null} [body]
 * @property {unknown[] | null} [commits]
 * @property {string | null} [headRefName]
 * @property {string | null} [headRefOid]
 * @property {string | null} [mergeable]
 * @property {IssueRef[] | null} [closingIssuesReferences]
 */

/**
 * A `gh pr list --json …` row.
 *
 * @typedef {object} GhPrListItem
 * @property {number} number
 * @property {string} title
 * @property {{ path: string }[] | null} [files]
 * @property {{ login?: string | null } | null} [author]
 * @property {IssueRef[] | null} [closingIssuesReferences]
 */

/** A `gh` call slower than this is stuck (network, rate limit); prepare fails instead of hanging. */
const GH_TIMEOUT_MS = 180_000;
/** How many open PRs are compared for overlapping files. */
const OPEN_PR_LIMIT = '300';
/** Shared files that say nothing about overlap (every PR touches the test file and lockfiles). */
const OVERLAP_IGNORED = new Set(['src/lib.rs', 'Cargo.lock', 'yarn.lock']);
/** `YYYY-MM-DD`, the date part of GitHub's ISO timestamps. */
const DATE_LENGTH = 10;
const PR_FIELDS =
  'number,title,author,body,state,isDraft,url,createdAt,updatedAt,baseRefName,headRefName,headRefOid,' +
  'headRepositoryOwner,mergeable,labels,closingIssuesReferences,files,additions,deletions,commits';

/**
 * `gh <args>` parsed as JSON (Python's number rules); null when it printed nothing.
 *
 * @param {string[]} args
 * @param {{ check?: boolean }} [options]
 * @returns {Promise<unknown>}
 */
export async function ghJson(args, { check = true } = {}) {
  const result = await run(['gh', ...args], { timeoutMs: GH_TIMEOUT_MS, check });

  // A checked run already throws on a timeout; an unchecked one must not read a half answer.
  if (result.timedOut) {
    throw new LcrError(`command timed out after ${GH_TIMEOUT_MS / 1000}s: ${shellJoin(result.argv)}`);
  }

  const output = universalNewlines(result.stdout);

  return pyStrip(output) ? loads(output) : null;
}

/**
 * The PR as `gh pr view` reports it.
 *
 * @param {number} prNumber
 * @returns {Promise<GhPr>}
 */
export async function viewPr(prNumber) {
  return /** @type {Promise<GhPr>} */ (
    ghJson(['pr', 'view', String(prNumber), '-R', UPSTREAM, '--json', PR_FIELDS])
  );
}

/**
 * prepare.json `pr`: the fields of the PR the report shows.
 *
 * @param {GhPr} pr
 * @returns {PrMeta}
 */
export function prMeta(pr) {
  return {
    number: pr.number,
    title: pr.title,
    author: loginOf(pr.author),
    url: pr.url,
    state: pr.state,
    draft: pr.isDraft ?? null,
    created: pySlice(pr.createdAt, 0, DATE_LENGTH),
    updated: pySlice(pr.updatedAt, 0, DATE_LENGTH),
    labels: listOf(pr.labels).map((label) => label.name),
    body: pr.body || '',
    commits: listOf(pr.commits).length,
    head_ref: pr.headRefName ?? null,
    mergeable: pr.mergeable ?? null,
  };
}

/**
 * A JSON list GitHub may send as null.
 *
 * @template T
 * @param {T[] | null | undefined} value
 * @returns {T[]}
 */
function listOf(value) {
  return value ?? [];
}

/**
 * The login of a PR author (null for a deleted account).
 *
 * @param {{ login?: string | null } | null | undefined} author
 * @returns {string | null}
 */
function loginOf(author) {
  return author?.login ?? null;
}

/**
 * @typedef {object} PrRefs What issue references are read from.
 * @property {number} number
 * @property {string | null} [title]
 * @property {string | null} [body]
 * @property {IssueRef[] | null} [closingIssuesReferences]
 */

/**
 * Issue numbers GitHub links as closing.
 *
 * @param {PrRefs} pr
 * @returns {Set<number>}
 */
function closingReferences(pr) {
  return new Set(
    listOf(pr.closingIssuesReferences)
      .filter((issue) => pyTruthy(issue.number))
      .map((issue) => /** @type {number} */ (issue.number)),
  );
}

/**
 * @param {PrRefs} pr
 * @returns {string}
 */
function referenceText(pr) {
  return `${pyTruthy(pr.body) ? pr.body : ''}\n${pyTruthy(pr.title) ? pr.title : ''}`;
}

const ISSUE_REFERENCE = pyRe(
  String.raw`(?:(?<![\w/])#|github\.com/parcel-bundler/lightningcss/issues/)(\d{1,5})\b`,
  'g',
);
const CLOSING_REFERENCE = pyRe(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+` +
    String.raw`(?:(?:https://)?github\.com/parcel-bundler/lightningcss/issues/|#)(\d{1,5})\b`,
  'gi',
);

/**
 * Every issue the PR mentions (`#N` or an issue URL in its body or title) plus GitHub's closing
 * references, without the PR itself.
 *
 * @param {PrRefs} pr
 * @returns {number[]} Sorted.
 */
export function linkedIssueNumbers(pr) {
  const numbers = closingReferences(pr);

  for (const match of referenceText(pr).matchAll(ISSUE_REFERENCE)) {
    numbers.add(pyIntOrRaise(match[1]));
  }

  numbers.delete(pr.number);

  return [...numbers].sort((a, b) => a - b);
}

/**
 * Issues the PR says it closes: GitHub's closing references plus `fixes/closes/resolves #N`.
 *
 * @param {PrRefs} pr
 * @returns {Set<number>}
 */
export function closingIssueNumbers(pr) {
  const numbers = closingReferences(pr);

  for (const match of referenceText(pr).matchAll(CLOSING_REFERENCE)) {
    numbers.add(pyIntOrRaise(match[1]));
  }

  return numbers;
}

/**
 * Fetch every linked issue into `issuesDir/<n>.json`; issues that cannot be read are skipped.
 *
 * @param {PrRefs} pr
 * @param {string} issuesDir
 * @returns {Promise<LinkedIssue[]>}
 */
export async function fetchLinkedIssues(pr, issuesDir) {
  const closing = closingIssueNumbers(pr);
  /** @type {LinkedIssue[]} */
  const linked = [];

  for (const number of linkedIssueNumbers(pr)) {
    /** @type {{ title: string, state: string } | null} */
    let issue;

    try {
      issue = /** @type {{ title: string, state: string } | null} */ (
        await ghJson([
          'issue',
          'view',
          String(number),
          '-R',
          UPSTREAM,
          '--json',
          'number,title,state,body,comments,labels,url',
        ])
      );
    } catch (error) {
      if (error instanceof LcrError) {
        // A PR number, or an issue this account cannot read.
        continue;
      }

      throw error;
    }

    if (issue !== null && pyTruthy(issue)) {
      writeJson(join(issuesDir, `${number}.json`), issue);
      linked.push({ number, title: issue.title, state: issue.state, closing: closing.has(number) });
    }
  }

  return linked;
}

/**
 * Open PRs that change the same files (shared lockfiles and src/lib.rs do not count), most shared
 * files first. Older `gh` versions lack `closingIssuesReferences` on `pr list`; then it is left out.
 *
 * @param {number} prNumber
 * @param {Iterable<string>} changedFiles
 * @returns {Promise<OverlappingPr[]>}
 */
export async function overlappingPrs(prNumber, changedFiles) {
  const mine = new Set(changedFiles);
  /** @type {OverlappingPr[]} */
  const overlaps = [];

  for (const other of listOf(await openPrs())) {
    if (other.number === prNumber) {
      continue;
    }

    const theirs = new Set(listOf(other.files).map((file) => file.path));
    const shared = [...mine].filter((path) => theirs.has(path) && !OVERLAP_IGNORED.has(path));

    if (shared.length > 0) {
      overlaps.push({
        number: other.number,
        title: other.title,
        author: loginOf(other.author),
        shared_files: shared.sort(compareCodePoints),
        linked_issues: listOf(other.closingIssuesReferences)
          .filter((issue) => pyTruthy(issue.number))
          .map((issue) => /** @type {number} */ (issue.number))
          .sort((a, b) => a - b),
      });
    }
  }

  return overlaps.sort((a, b) => b.shared_files.length - a.shared_files.length || a.number - b.number);
}

/**
 * @returns {Promise<GhPrListItem[] | null>}
 */
async function openPrs() {
  const list = ['pr', 'list', '-R', UPSTREAM, '--state', 'open', '--limit', OPEN_PR_LIMIT, '--json'];

  try {
    return /** @type {GhPrListItem[] | null} */ (
      await ghJson([...list, 'number,title,files,author,updatedAt,closingIssuesReferences'])
    );
  } catch (error) {
    if (!(error instanceof LcrError)) {
      throw error;
    }
  }

  try {
    return /** @type {GhPrListItem[] | null} */ (
      await ghJson([...list, 'number,title,files,author,updatedAt'])
    );
  } catch (error) {
    if (!(error instanceof LcrError)) {
      throw error;
    }

    return [];
  }
}

/**
 * The PR's CI checks, sorted by name. `gh pr checks` exits non-zero when checks fail or are
 * pending; its JSON is still valid, so the exit status is ignored.
 *
 * @param {number} prNumber
 * @returns {Promise<CiCheck[]>}
 */
export async function ciChecks(prNumber) {
  /** @type {CiCheck[] | null} */
  let checks;

  try {
    checks = /** @type {CiCheck[] | null} */ (
      await ghJson(['pr', 'checks', String(prNumber), '-R', UPSTREAM, '--json', 'name,state,bucket,link'], {
        check: false,
      })
    );
  } catch (error) {
    if (!(error instanceof LcrError) && !(error instanceof SyntaxError)) {
      throw error;
    }

    checks = [];
  }

  return [...listOf(checks)].sort((a, b) => compareCodePoints(a.name, b.name));
}
