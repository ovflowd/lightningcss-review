/**
 * Line-based heuristics over Rust source that tell what a change touches: the enclosing `fn` and
 * `impl` of each changed range, the `#[test]` functions of src/lib.rs whose bodies changed, and
 * the `Feature` variants of the generated src/compat.rs whose entries changed.
 *
 * Stage: prepare (prepare.json `changed_items`, `changed_tests`, `compat_variants`).
 *
 * Invariant: deterministic and purely textual (no parser), exactly py-final's rules, so the same
 * diff always yields the same items, areas and blast radius.
 */
import { pyRe } from '../core/py-re.js';
import { compareCodePoints, pyLen, pySplitlines, pyStrip } from '../core/py.js';

/** @import { ChangedItem } from '../types.js' */

const ITEM = pyRe(
  String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe|extern "C")\s+)*` +
    String.raw`(fn|struct|enum|trait|type|macro_rules!|mod)\s+([A-Za-z_][A-Za-z0-9_]*)`,
);
const IMPL = pyRe(
  String.raw`^\s*impl(?:<[^>]*>)?\s+(?:([A-Za-z_:][A-Za-z0-9_:<>,' ]*?)\s+for\s+)?([A-Za-z_][A-Za-z0-9_]*)`,
);

/**
 * For each changed range, the nearest `fn`/`struct`/… and `impl` at or above its last line.
 *
 * @param {string} text
 * @param {[number, number][]} ranges 1-based inclusive line ranges.
 * @returns {Pick<ChangedItem, 'range' | 'item' | 'impl'>[]}
 */
export function enclosingItems(text, ranges) {
  const lines = pySplitlines(text);

  return ranges.map(([start, end]) => {
    /** @type {ChangedItem['item']} */
    let item = null;
    /** @type {ChangedItem['impl']} */
    let impl = null;

    for (let index = Math.min(end, lines.length) - 1; index >= 0 && !(item && impl); index--) {
      item ??= itemAt(lines[index], index);
      impl ??= implAt(lines[index], index);
    }

    return { range: [start, end], item, impl };
  });
}

/**
 * @param {string} line
 * @param {number} index
 * @returns {ChangedItem['item']}
 */
function itemAt(line, index) {
  const match = ITEM.exec(line);

  return match ? { kind: match[1], name: match[2], line: index + 1 } : null;
}

/**
 * @param {string} line
 * @param {number} index
 * @returns {ChangedItem['impl']}
 */
function implAt(line, index) {
  const match = IMPL.exec(line);

  return match ? { trait: pyStrip(match[1] ?? '') || null, type: match[2], line: index + 1 } : null;
}

const FEATURE_ENUM = pyRe(String.raw`^pub enum Feature\b`);
const ENUM_ENTRY = pyRe(String.raw`^\s*(\w+),?\s*$`);
const FEATURE_NAME = pyRe(String.raw`Feature::(\w+)`, 'g');
const FN_LINE = pyRe(String.raw`^\s*(pub )?fn `);
const FEATURE_ARM = pyRe(String.raw`^\s*(?:\|\s*)?Feature::\w+`);

/**
 * `Feature` variants of the generated src/compat.rs whose enum entry or match arm contains a
 * changed line. An arm is `Feature::A | Feature::B => { version checks }`, so a changed version
 * check is attributed to every variant of the arm above it.
 *
 * @param {string} text
 * @param {[number, number][]} ranges Added (head) or removed (base) lines only.
 * @returns {string[]} Sorted.
 */
export function compatVariants(text, ranges) {
  const lines = pySplitlines(text);
  const enumStart = lines.findIndex((line) => FEATURE_ENUM.test(line));
  const enumEnd =
    enumStart < 0 ? -1 : lines.findIndex((line, index) => index >= enumStart && line.startsWith('}'));
  const inEnum = (/** @type {number} */ index) =>
    enumStart >= 0 && enumStart < index && index < (enumEnd < 0 ? lines.length : enumEnd);
  /** @type {Set<string>} */
  const found = new Set();

  for (const [start, end] of ranges) {
    for (let index = start - 1; index < Math.min(end, lines.length); index++) {
      const line = lines[index];

      if (inEnum(index)) {
        const entry = ENUM_ENTRY.exec(line);

        if (entry) {
          found.add(entry[1]);
        }
      } else if (line.includes('Feature::')) {
        addFeatureNames(found, line);
      } else {
        addArmAbove(found, lines, index);
      }
    }
  }

  return [...found].sort(compareCodePoints);
}

/**
 * @param {Set<string>} found
 * @param {string} line
 * @returns {void}
 */
function addFeatureNames(found, line) {
  for (const match of line.matchAll(FEATURE_NAME)) {
    found.add(match[1]);
  }
}

/**
 * The variants of the match arm a version-check line belongs to: the nearest `Feature::… =>`
 * line above it (not crossing a `fn`), plus the `| Feature::X` continuation lines above that.
 *
 * @param {Set<string>} found
 * @param {string[]} lines
 * @param {number} index
 * @returns {void}
 */
function addArmAbove(found, lines, index) {
  for (let above = index - 1; above >= 0; above--) {
    const line = lines[above];

    if (FN_LINE.test(line)) {
      return;
    }

    if (line.includes('=>') && line.includes('Feature::')) {
      addFeatureNames(found, line);

      for (let up = above - 1; up >= 0 && FEATURE_ARM.test(lines[up]) && !lines[up].includes('=>'); up--) {
        addFeatureNames(found, lines[up]);
      }

      return;
    }
  }
}

const FN_START = pyRe(String.raw`^(\s*)(?:pub(?:\([^)]*\))?\s+)?fn (\w+)`);

/**
 * Names of the `#[test] fn` items of src/lib.rs whose bodies contain a changed line.
 *
 * A test's span starts at its attribute lines (an added `#[test]` counts for the test it
 * introduces) and ends where the next `fn` at the same indentation starts, so helpers between
 * tests belong to no test; blank lines change nothing. Pass only added/removed lines
 * (`changedLines`), not whole hunks.
 *
 * @param {string} text
 * @param {[number, number][]} ranges
 * @returns {string[]} Sorted.
 */
export function testFnsInRanges(text, ranges) {
  const lines = pySplitlines(text);
  const starts = spanStarts(lines);
  /** @type {Set<string>} */
  const names = new Set();

  for (const [start, end] of ranges) {
    for (let lineNo = start; lineNo <= Math.min(end, lines.length); lineNo++) {
      if (!pyStrip(lines[lineNo - 1])) {
        continue;
      }

      const name = starts.findLast(([fnStart]) => fnStart <= lineNo)?.[1];

      if (name) {
        names.add(name);
      }
    }
  }

  return [...names].sort(compareCodePoints);
}

/**
 * `[first line of the span, test name or null]` for every `fn` at an indentation where tests
 * live, in file order.
 *
 * @param {string[]} lines
 * @returns {[number, string | null][]}
 */
function spanStarts(lines) {
  /** @type {{ index: number, indent: number, name: string | null }[]} */
  const fns = [];

  lines.forEach((line, index) => {
    const match = FN_START.exec(line);

    if (match) {
      const isTest = match[2].startsWith('test_') && index > 0 && pyStrip(lines[index - 1]) === '#[test]';

      fns.push({ index, indent: pyLen(match[1]), name: isTest ? match[2] : null });
    }
  });

  const testIndents = new Set(fns.filter(({ name }) => name).map(({ indent }) => indent));

  return fns
    .filter(({ indent }) => testIndents.has(indent))
    .map(({ index, name }) => {
      let first = index;

      while (first > 0 && pyStrip(lines[first - 1]).startsWith('#[')) {
        first--;
      }

      return [first + 1, name];
    });
}
