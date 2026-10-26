#!/usr/bin/env node
/**
 * Keep the agent's context small and timeless.
 *
 * Everything an agent reads during a review (SKILL.md, references/) must explain mechanisms, not
 * history: no issue/PR numbers, commit hashes, release versions or line numbers, which go stale and
 * cost tokens without telling a reviewer what to check. Files also have size budgets. Probe files
 * and config are data, not instructions, and are not checked here.
 *
 * Stage: CI and `npm run check` (run from anywhere). Prints one line per problem, then a summary;
 * exits 1 when there is any problem. Output and exit status are py-final's
 * scripts/lint_context.py, character for character: sizes are UTF-8 bytes of the text as Python
 * reads it (universal newlines), and the patterns use Python's Unicode `\w`, `\d`, `\s`, `\b`.
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { print } from '../lib/core/log.js';
import { walkTree } from '../lib/core/pathlib.js';
import { PY_DIGIT, PY_NON_SPACE, PY_SPACE, PY_WORD_END, PY_WORD_START } from '../lib/core/py-re.js';
import { fnmatchcase, pyRepr, pySorted, pySplitlines } from '../lib/core/py.js';

const ROOT = resolve(import.meta.dirname, '..');

/** Size budgets in bytes; the first matching pattern applies (fnmatch: `*` crosses `/`). */
const BUDGET = /** @type {const} */ ([
  ['SKILL.md', 12000],
  ['references/checklists/general.md', 5000],
  ['references/checklists/*.md', 4500],
  ['references/spec/*.md', 8000],
  ['references/*.md', 9000],
]);

/**
 * What may not appear outside URLs, first match per line wins. The classes are Python's
 * Unicode-aware `\d`, `\s` and `\b` (lib/core/py-re.js), so the linter keeps flagging exactly
 * what it always flagged.
 */
const FORBIDDEN = /** @type {const} */ ([
  [new RegExp(String.raw`(?<![\p{L}\p{N}_&/])#${PY_DIGIT}{2,5}${PY_WORD_END}`, 'u'), 'issue/PR number'],
  [
    new RegExp(
      String.raw`${PY_WORD_START}(?:PRs?|issues?|pull)${PY_SPACE}+#?${PY_DIGIT}{2,5}${PY_WORD_END}`,
      'iu',
    ),
    'issue/PR reference',
  ],
  [new RegExp(String.raw`(?<![\p{L}\p{N}_/.\-])[0-9a-f]{7,40}(?![\p{L}\p{N}_\-])`, 'u'), 'commit hash'],
  [
    new RegExp(String.raw`${PY_WORD_START}v?1\.(?:[1-3]${PY_DIGIT})\.${PY_DIGIT}+${PY_WORD_END}`, 'u'),
    'Lightning CSS release version',
  ],
  [new RegExp(String.raw`\.(?:rs|js|mjs|toml):${PY_DIGIT}+`, 'u'), 'file:line reference'],
]);

const URL = new RegExp(`https?://${PY_NON_SPACE}+`, 'gu');

/**
 * The size budget of a file (0: none).
 *
 * @param {string} rel
 * @returns {number}
 */
function budgetFor(rel) {
  return BUDGET.find(([pattern]) => fnmatchcase(rel, pattern))?.[1] ?? 0;
}

/**
 * SKILL.md, then every Markdown file under references/ in pathlib's order (by path component).
 *
 * @param {string} root
 * @returns {string[]}
 */
function contextFiles(root) {
  const references = join(root, 'references');
  const markdown = [...walkTree(references)]
    .filter((entry) => entry.name.endsWith('.md') && !entry.isDirectory)
    .map((entry) => entry.path);

  return [join(root, 'SKILL.md'), ...pySorted(markdown, (path) => path.split(sep))];
}

/**
 * Problems of one line: the first forbidden pattern found outside URLs.
 *
 * @param {string} line
 * @returns {string | null}
 */
function lineProblem(line) {
  const text = line.includes('http://') || line.includes('https://') ? line.replace(URL, '') : line;

  for (const [pattern, what] of FORBIDDEN) {
    const match = pattern.exec(text);

    if (match) {
      return `${what}: ${pyRepr(match[0])}`;
    }
  }

  return null;
}

/**
 * Lint every context file; returns the exit status.
 *
 * @param {string} [root] The skill checkout.
 * @returns {number}
 */
export function lintContext(root = ROOT) {
  const files = contextFiles(root);
  let problems = 0;
  let total = 0;

  for (const path of files) {
    const rel = relative(root, path);
    // Python reads text with universal newlines, so `\r\n` counts as one byte.
    const text = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
    const size = Buffer.byteLength(text);
    const limit = budgetFor(rel);

    total += size;

    if (limit && size > limit) {
      print(`${rel}: ${size} bytes > budget ${limit}`);
      problems++;
    }

    for (const [index, line] of pySplitlines(text).entries()) {
      const problem = lineProblem(line);

      if (problem) {
        print(`${rel}:${index + 1}: ${problem}`);
        problems++;
      }
    }
  }

  print(`${files.length} files, ${total} bytes, ${problems} problems`);

  return problems ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = lintContext();
}
