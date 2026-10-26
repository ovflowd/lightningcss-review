/**
 * Read a `git diff` patch: changed line ranges per file, added/removed line counts and the text of
 * the added or removed lines.
 *
 * Stage: prepare. The patch is diff.patch of the run (`git diff --no-color --no-ext-diff -M
 * <base> <head-tree>`); ranges feed prepare.json `files.<path>.head/base`, the changed-item and
 * changed-test detection and the risk flags.
 *
 * Invariant: lines are split as Python's `str.splitlines()` splits them (form feeds, U+2028 and
 * friends end a line too), so counts and ranges equal py-final's on any input.
 */
import { pyIntOrRaise } from '../core/py-number.js';
import { pyRe } from '../core/py-re.js';
import { pySplitlines } from '../core/py.js';

/**
 * @typedef {object} FileHunks
 * @property {[number, number][]} head Changed line ranges on head (whole hunks, context included).
 * @property {[number, number][]} base Changed line ranges on base.
 * @property {number} added
 * @property {number} removed
 */

/**
 * @typedef {object} ChangedLines Only the added (head) and removed (base) lines, no context.
 * @property {[number, number][]} head
 * @property {[number, number][]} base
 */

const FILE_HEADER = pyRe(String.raw`^diff --git a/(.*?) b/(.*)$`);
const HUNK_HEADER = pyRe(String.raw`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`);
const HUNK_START = pyRe(String.raw`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@`);

/**
 * The file a `diff --git a/<old> b/<new>` line starts (the new path), or null when the header
 * does not parse (paths git had to quote).
 *
 * @param {string} line
 * @returns {string | null}
 */
function fileOf(line) {
  return FILE_HEADER.exec(line)?.[2] || null;
}

/**
 * file -> hunk ranges on both sides plus added/removed line counts.
 *
 * @param {string} patch
 * @returns {Map<string, FileHunks>}
 */
export function parseHunks(patch) {
  /** @type {Map<string, FileHunks>} */
  const files = new Map();
  /** @type {FileHunks | null} */
  let current = null;

  for (const line of pySplitlines(patch)) {
    if (line.startsWith('diff --git ')) {
      current = startFile(files, fileOf(line), () => ({ head: [], base: [], added: 0, removed: 0 }));
      continue;
    }

    if (current === null) {
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);

    if (hunk) {
      addHunk(current, hunk);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.removed++;
    }
  }

  return files;
}

/**
 * The entry of `path`, created with `fresh()` the first time; null when the header named no path.
 *
 * @template T
 * @param {Map<string, T>} files
 * @param {string | null} path
 * @param {() => T} fresh
 * @returns {T | null}
 */
function startFile(files, path, fresh) {
  if (path === null) {
    return null;
  }

  if (!files.has(path)) {
    files.set(path, fresh());
  }

  return /** @type {T} */ (files.get(path));
}

/**
 * `@@ -b0,bn +h0,hn @@`: a missing count means one line; a zero count (pure addition or
 * deletion) adds no range on that side.
 *
 * @param {FileHunks} file
 * @param {RegExpExecArray} hunk
 * @returns {void}
 */
function addHunk(file, hunk) {
  const baseStart = pyIntOrRaise(hunk[1]);
  const baseCount = hunk[2] === undefined ? 1 : pyIntOrRaise(hunk[2]);
  const headStart = pyIntOrRaise(hunk[3]);
  const headCount = hunk[4] === undefined ? 1 : pyIntOrRaise(hunk[4]);

  if (baseCount) {
    file.base.push([baseStart, baseStart + baseCount - 1]);
  }

  if (headCount) {
    file.head.push([headStart, headStart + headCount - 1]);
  }
}

/**
 * file -> ranges of added lines (head numbering) and removed lines (base numbering), without the
 * context lines a hunk carries: a hunk's context belongs to its neighbors, not to the change.
 *
 * @param {string} patch
 * @returns {Map<string, ChangedLines>}
 */
export function changedLines(patch) {
  /** @type {Map<string, ChangedLines>} */
  const files = new Map();
  /** @type {ChangedLines | null} */
  let current = null;
  let inHeader = false;
  let baseLine = 0;
  let headLine = 0;

  for (const line of pySplitlines(patch)) {
    if (line.startsWith('diff --git ')) {
      current = startFile(files, fileOf(line), () => ({ head: [], base: [] }));
      inHeader = true;
      continue;
    }

    if (current === null) {
      continue;
    }

    const hunk = HUNK_START.exec(line);

    if (hunk) {
      baseLine = pyIntOrRaise(hunk[1]);
      headLine = pyIntOrRaise(hunk[2]);
      inHeader = false;
    } else if (inHeader) {
      // `--- a/…` and `+++ b/…` before the first hunk are file headers, not changed lines.
    } else if (line.startsWith('+')) {
      extendRanges(current.head, headLine++);
    } else if (line.startsWith('-')) {
      extendRanges(current.base, baseLine++);
    } else if (line.startsWith(' ')) {
      baseLine++;
      headLine++;
    }
  }

  return files;
}

/**
 * Add a line number, merging it into the last range when it directly follows it.
 *
 * @param {[number, number][]} ranges
 * @param {number} line
 * @returns {void}
 */
function extendRanges(ranges, line) {
  const last = ranges.at(-1);

  if (last && last[1] === line - 1) {
    last[1] = line;
  } else {
    ranges.push([line, line]);
  }
}

/**
 * file -> the text of its added lines (`sign` `+`, the default) or removed lines (`-`), without
 * the sign. `+++`/`---` lines are file headers, not content.
 *
 * @param {string} patch
 * @param {{ sign?: '+' | '-' }} [options]
 * @returns {Map<string, string[]>}
 */
export function addedLinesByFile(patch, { sign = '+' } = {}) {
  /** @type {Map<string, string[]>} */
  const files = new Map();
  /** @type {string | null} */
  let current = null;

  for (const line of pySplitlines(patch)) {
    if (line.startsWith('diff --git ')) {
      current = fileOf(line);
      continue;
    }

    if (current && line.startsWith(sign) && !line.startsWith(sign.repeat(3))) {
      const lines = files.get(current) ?? [];

      lines.push(line.slice(1));
      files.set(current, lines);
    }
  }

  return files;
}
