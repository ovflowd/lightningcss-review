/**
 * The spec checklists (references/checklists/<list>.md) and the reviewer's answers to them.
 *
 * Stage: report (A1/A3 and the checklist table) and `lcr worklist` (which writes an answer slot
 * per item). A run's checklist is `general` plus one list per touched area; an item is identified
 * by its id (`COLOR-01`), and the first list that defines an id wins.
 *
 * File format, one item per bullet, with indented attributes:
 *
 *     - [COLOR-01] (MAJOR) Colors stay equivalent after minification.
 *       verify: a `lower-minify` probe or a minify test
 *       covers: src/values/color.rs
 *       same-root-as: GEN-06
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readText } from '../core/files.js';
import { SKILL_DIR } from '../core/paths.js';
import {
  compareCodePoints,
  fnmatchcase,
  PY_WHITESPACE,
  pyStrip,
  pySplitlines,
  pyTruthy,
} from '../core/py.js';

/** @import { Analysis, ChecklistAnswer, Severity } from '../types.js' */

/**
 * @typedef {object} ChecklistItem One item of references/checklists/<list>.md.
 * @property {string} item e.g. `COLOR-01`.
 * @property {Severity} severity
 * @property {string} text
 * @property {string} list The checklist (area) name.
 * @property {string} verify What evidence settles the item.
 * @property {string[]} covers Globs of the files the item is about (empty: always relevant).
 * @property {string} [same_root_as] The item whose defect this one restates.
 */

/**
 * An answer as the report resolves it: area-level N/A answers are copied to every item of the area
 * and marked `area_level`.
 *
 * @typedef {ChecklistAnswer & { area_level?: boolean }} ResolvedAnswer
 */

const CHECKLIST_DIR = join(SKILL_DIR, 'references', 'checklists');

/** The list every run answers, whatever it touches. */
const GENERAL_LIST = 'general';

const ITEM_LINE = /^- \[([A-Z0-9]+-\p{Nd}+)\] \((BLOCKER|MAJOR|MINOR|NOTE)\) ([^\n]+)$/u;
const COVERS_SEPARATOR = new RegExp(`[${PY_WHITESPACE},\`]+`, 'u');

/** Attribute lines of an item, by prefix. */
const ATTRIBUTES = /** @type {const} */ ({
  verify: 'verify:',
  covers: 'covers:',
  sameRootAs: 'same-root-as:',
});

/**
 * The items of `general` plus the given areas' checklists (areas in sorted order), first
 * occurrence of an id kept.
 *
 * @param {readonly string[]} areas
 * @returns {ChecklistItem[]}
 */
export function loadChecklists(areas) {
  const names = [GENERAL_LIST, ...[...areas].sort(compareCodePoints)];
  /** @type {Map<string, ChecklistItem>} */
  const items = new Map();

  for (const name of names) {
    const path = join(CHECKLIST_DIR, `${name}.md`);

    if (!existsSync(path)) {
      continue;
    }

    for (const item of parseChecklist(readText(path), name)) {
      if (!items.has(item.item)) {
        items.set(item.item, item);
      }
    }
  }

  return [...items.values()];
}

/**
 * Every item of one checklist file, in file order.
 *
 * @param {string} text
 * @param {string} list
 * @returns {ChecklistItem[]}
 */
export function parseChecklist(text, list) {
  /** @type {ChecklistItem[]} */
  const items = [];
  /** @type {ChecklistItem | null} */
  let current = null;

  for (const raw of pySplitlines(text)) {
    const line = pyStrip(raw);
    const match = ITEM_LINE.exec(line);

    if (match) {
      const [, item, severity, title] = match;

      current = {
        item,
        severity: /** @type {Severity} */ (severity),
        text: title,
        list,
        verify: '',
        covers: [],
      };
      items.push(current);
    } else if (current) {
      readAttribute(current, line);
    }
  }

  return items;
}

/**
 * Apply one attribute line (`verify:`, `covers:`, `same-root-as:`) to the item it follows.
 *
 * @param {ChecklistItem} item
 * @param {string} line Stripped.
 * @returns {void}
 */
function readAttribute(item, line) {
  if (line.startsWith(ATTRIBUTES.verify)) {
    item.verify = pyStrip(line.slice(ATTRIBUTES.verify.length));
  } else if (line.startsWith(ATTRIBUTES.covers)) {
    item.covers = line
      .slice(ATTRIBUTES.covers.length)
      .split(COVERS_SEPARATOR)
      .filter((glob) => glob !== '');
  } else if (line.startsWith(ATTRIBUTES.sameRootAs)) {
    item.same_root_as = pyStrip(line.slice(ATTRIBUTES.sameRootAs.length));
  }
}

/**
 * True when the item names the files it is about and the diff touches none of them (the worklist
 * pre-fills such items with N/A).
 *
 * @param {Pick<ChecklistItem, 'covers'>} item
 * @param {Iterable<string>} files
 * @returns {boolean}
 */
export function untouchedCovers(item, files) {
  const covers = item.covers ?? [];

  if (covers.length === 0) {
    return false;
  }

  for (const file of files) {
    if (covers.some((glob) => fnmatchcase(file, glob))) {
      return false;
    }
  }

  return true;
}

/**
 * Checklist answers by item, in the order the report reads them. An answer with an `answer` beats
 * an earlier one for the same item; an empty one only fills a gap. An entry
 * `{ "area": "<list>", "answer": "N/A", … }` answers every item of that (non-general) list that has
 * no answer of its own.
 *
 * @param {Partial<Analysis>} analysis
 * @param {readonly ChecklistItem[]} checklist
 * @returns {Map<unknown, ResolvedAnswer>}
 */
export function resolveAnswerMap(analysis, checklist) {
  /** @type {Map<unknown, ResolvedAnswer>} */
  const answers = new Map();
  /** @type {Map<unknown, ChecklistAnswer>} */
  const areaAnswers = new Map();

  for (const answer of analysis.checklist ?? []) {
    if (pyTruthy(answer.item) && (pyTruthy(answer.answer) || !answers.has(answer.item))) {
      answers.set(answer.item, answer);
    }

    if (isAreaNotApplicable(answer)) {
      areaAnswers.set(answer.area, answer);
    }
  }

  for (const item of checklist) {
    const area = areaAnswers.get(item.list);

    if (area && !pyTruthy(answers.get(item.item)?.answer)) {
      answers.set(item.item, { ...area, item: item.item, area_level: true });
    }
  }

  return answers;
}

/**
 * @param {ChecklistAnswer} answer
 * @returns {boolean}
 */
function isAreaNotApplicable(answer) {
  return (
    pyTruthy(answer.area) && !pyTruthy(answer.item) && answer.answer === 'N/A' && answer.area !== GENERAL_LIST
  );
}

/**
 * Checklist answers by item id, with area-level N/A answers expanded (see `resolveAnswerMap`).
 *
 * @param {Partial<Analysis>} analysis
 * @param {readonly ChecklistItem[]} checklist
 * @returns {Record<string, ResolvedAnswer>}
 */
export function resolveAnswers(analysis, checklist) {
  /** @type {Record<string, ResolvedAnswer>} */
  const answers = Object.create(null);

  for (const [item, answer] of resolveAnswerMap(analysis, checklist)) {
    answers[String(item)] = answer;
  }

  return answers;
}
