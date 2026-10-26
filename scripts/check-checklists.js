#!/usr/bin/env node
/**
 * Fail if any checklist breaks the format `lcr report` parses (see CONTRIBUTING.md):
 *
 *     - [PREFIX-n] (BLOCKER|MAJOR|MINOR|NOTE) <the requirement>
 *       verify: <how to check it>
 *
 * with one id prefix per file and ids numbered 1..n without gaps.
 *
 * Stage: CI and `npm run check`. Prints one line per problem, then a summary; exits 1 when there
 * is any problem. It accepts exactly the lines `lcr report` parses, so it uses the same rules
 * (Python's `\d`, line splitting and whitespace rules included), and its output and exit status
 * are stable across versions.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { print } from '../lib/core/log.js';
import { pyInt } from '../lib/core/py-number.js';
import { pyRepr, pySplitlines, pyStrip } from '../lib/core/py.js';
import { compareCodePoints } from '../lib/core/pyjson.js';

const ROOT = resolve(import.meta.dirname, '..', 'references', 'checklists');
const ITEM = /^- \[([A-Z0-9]+)-(\p{Nd}+)\] \((BLOCKER|MAJOR|MINOR|NOTE)\) (.+)$/u;

/**
 * The checklist files, by name (pathlib's `glob('*.md')`: dotfiles included).
 *
 * @param {string} root
 * @returns {string[]}
 */
function checklistFiles(root) {
  return readdirSync(root)
    .filter((name) => name.endsWith('.md'))
    .sort(compareCodePoints);
}

/**
 * The problems of one checklist, as printed lines.
 *
 * @param {string} name
 * @param {string} text
 * @returns {string[]}
 */
export function checklistProblems(name, text) {
  const lines = pySplitlines(text);
  /** @type {string[]} */
  const problems = [];
  /** @type {number[]} */
  const ids = [];
  /** @type {Set<string>} */
  const prefixes = new Set();

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('- [')) {
      continue;
    }

    const match = ITEM.exec(pyStrip(line));

    if (!match) {
      problems.push(`${name}:${index + 1}: malformed item`);
      continue;
    }

    prefixes.add(match[1]);
    // `\p{Nd}+` matched, so Python's int() of it cannot fail.
    ids.push(/** @type {number} */ (pyInt(match[2])));

    if (!pyStrip(lines[index + 1] ?? '').startsWith('verify:')) {
      problems.push(`${name}:${index + 1}: item without a verify: line`);
    }
  }

  if (prefixes.size > 1) {
    problems.push(`${name}: more than one id prefix ${pyRepr([...prefixes].sort(compareCodePoints))}`);
  }

  if (ids.some((id, index) => id !== index + 1)) {
    problems.push(`${name}: ids are not numbered 1..${ids.length} without gaps`);
  }

  return problems;
}

/**
 * Check every checklist; returns the exit status.
 *
 * @param {string} [root] The checklists directory.
 * @returns {number}
 */
export function checkChecklists(root = ROOT) {
  const names = checklistFiles(root);
  let problems = 0;

  for (const name of names) {
    for (const problem of checklistProblems(name, readFileSync(join(root, name), 'utf8'))) {
      print(problem);
      problems++;
    }
  }

  print(`${names.length} checklists, ${problems} problems`);

  return problems ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = checkChecklists();
}
