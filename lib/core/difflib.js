/**
 * An exact reproduction of the parts of Python's `difflib` the harness prints.
 *
 * Stage: shared by build (generated-file drift signatures), report (diff excerpts of real-world
 * outputs) and show (diff of pretty-printed outputs). Drift signatures land in build.json and the
 * report is diffed between runs, both fixed formats, so the matcher must pick exactly the blocks
 * CPython picks: same longest-match search, same tie-breaking, same "autojunk" rule for popular
 * lines (in sequences of 200+ items, an item that occurs more than 1% + 1 times is ignored as a
 * match anchor).
 *
 * Only `isjunk=None` is supported; the harness never passes a junk filter.
 */

/** Sequences shorter than this never get autojunk treatment. */
const AUTOJUNK_MIN_LENGTH = 200;

/** @typedef {[number, number, number]} MatchBlock `[i, j, size]`: a[i:i+size] == b[j:j+size]. */
/** @typedef {'replace' | 'delete' | 'insert' | 'equal'} OpTag */
/** @typedef {[OpTag, number, number, number, number]} Opcode `[tag, i1, i2, j1, j2]`. */

/**
 * Python's `difflib.SequenceMatcher(None, a, b)` over sequences of strings.
 */
export class SequenceMatcher {
  /**
   * @param {readonly string[]} a
   * @param {readonly string[]} b
   * @param {{ autojunk?: boolean }} [options]
   */
  constructor(a, b, { autojunk = true } = {}) {
    this.a = a;
    this.b = b;
    this.autojunk = autojunk;
    /** @type {Map<string, number[]>} */
    this.b2j = this.chainB();
    /** @type {MatchBlock[] | null} */
    this.matchingBlocks = null;
    /** @type {Opcode[] | null} */
    this.opcodes = null;
  }

  /**
   * Index every item of `b`, then drop the popular ones (CPython's `__chain_b`).
   *
   * @returns {Map<string, number[]>}
   */
  chainB() {
    /** @type {Map<string, number[]>} */
    const b2j = new Map();

    this.b.forEach((item, index) => {
      const indices = b2j.get(item);

      if (indices) {
        indices.push(index);
      } else {
        b2j.set(item, [index]);
      }
    });

    const length = this.b.length;

    if (this.autojunk && length >= AUTOJUNK_MIN_LENGTH) {
      const threshold = Math.floor(length / 100) + 1;

      for (const [item, indices] of [...b2j]) {
        if (indices.length > threshold) {
          b2j.delete(item);
        }
      }
    }

    return b2j;
  }

  /**
   * The longest matching block in a[aLow:aHigh] and b[bLow:bHigh]; among equals, the one that
   * starts earliest in `a`, then earliest in `b`. No junk set exists with `isjunk=None`, so
   * CPython's junk-extension loops reduce to the plain extension below.
   *
   * @param {number} aLow
   * @param {number} aHigh
   * @param {number} bLow
   * @param {number} bHigh
   * @returns {MatchBlock}
   */
  findLongestMatch(aLow, aHigh, bLow, bHigh) {
    const { a, b } = this;
    let [bestI, bestJ, bestSize] = [aLow, bLow, 0];
    /** @type {Map<number, number>} */
    let j2len = new Map();

    for (let i = aLow; i < aHigh; i++) {
      /** @type {Map<number, number>} */
      const next = new Map();

      for (const j of this.b2j.get(a[i]) ?? []) {
        if (j < bLow) {
          continue;
        }

        if (j >= bHigh) {
          break;
        }

        const size = (j2len.get(j - 1) ?? 0) + 1;

        next.set(j, size);

        if (size > bestSize) {
          [bestI, bestJ, bestSize] = [i - size + 1, j - size + 1, size];
        }
      }

      j2len = next;
    }

    // Popular items were not indexed; grow the match over them on both ends.
    while (bestI > aLow && bestJ > bLow && a[bestI - 1] === b[bestJ - 1]) {
      [bestI, bestJ, bestSize] = [bestI - 1, bestJ - 1, bestSize + 1];
    }

    while (
      bestI + bestSize < aHigh &&
      bestJ + bestSize < bHigh &&
      a[bestI + bestSize] === b[bestJ + bestSize]
    ) {
      bestSize++;
    }

    return [bestI, bestJ, bestSize];
  }

  /**
   * Non-overlapping matching blocks in order, adjacent ones merged, ending with `[len(a), len(b), 0]`.
   *
   * @returns {MatchBlock[]}
   */
  getMatchingBlocks() {
    if (this.matchingBlocks) {
      return this.matchingBlocks;
    }

    const blocks = this.collectBlocks();

    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    this.matchingBlocks = [...mergeAdjacent(blocks), [this.a.length, this.b.length, 0]];

    return this.matchingBlocks;
  }

  /**
   * Recursive longest-match subdivision, with an explicit LIFO queue as in CPython.
   *
   * @returns {MatchBlock[]}
   */
  collectBlocks() {
    /** @type {[number, number, number, number][]} */
    const queue = [[0, this.a.length, 0, this.b.length]];
    /** @type {MatchBlock[]} */
    const blocks = [];

    while (queue.length > 0) {
      const [aLow, aHigh, bLow, bHigh] = /** @type {[number, number, number, number]} */ (queue.pop());
      const block = this.findLongestMatch(aLow, aHigh, bLow, bHigh);
      const [i, j, size] = block;

      if (size === 0) {
        continue;
      }

      blocks.push(block);

      if (aLow < i && bLow < j) {
        queue.push([aLow, i, bLow, j]);
      }

      if (i + size < aHigh && j + size < bHigh) {
        queue.push([i + size, aHigh, j + size, bHigh]);
      }
    }

    return blocks;
  }

  /**
   * How to turn `a` into `b`, as CPython's `get_opcodes()`.
   *
   * @returns {Opcode[]}
   */
  getOpcodes() {
    if (this.opcodes) {
      return this.opcodes;
    }

    /** @type {Opcode[]} */
    const answer = [];
    let [i, j] = [0, 0];

    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      const tag = opcodeTag(i < ai, j < bj);

      if (tag) {
        answer.push([tag, i, ai, j, bj]);
      }

      [i, j] = [ai + size, bj + size];

      if (size) {
        answer.push(['equal', ai, i, bj, j]);
      }
    }

    this.opcodes = answer;

    return answer;
  }

  /**
   * Opcodes grouped into hunks with up to `context` lines of context (`get_grouped_opcodes(n)`).
   *
   * @param {number} [context]
   * @returns {Opcode[][]}
   */
  getGroupedOpcodes(context = 3) {
    /** @type {Opcode[]} */
    const codes = this.getOpcodes().map((code) => [...code]);

    if (codes.length === 0) {
      codes.push(['equal', 0, 1, 0, 1]);
    }

    trimOuterContext(codes, context);

    return splitIntoGroups(codes, context);
  }
}

/**
 * @param {boolean} aChanged
 * @param {boolean} bChanged
 * @returns {OpTag | ''}
 */
function opcodeTag(aChanged, bChanged) {
  if (aChanged && bChanged) {
    return 'replace';
  }

  if (aChanged) {
    return 'delete';
  }

  return bChanged ? 'insert' : '';
}

/**
 * @param {MatchBlock[]} blocks Sorted blocks.
 * @returns {MatchBlock[]}
 */
function mergeAdjacent(blocks) {
  /** @type {MatchBlock[]} */
  const merged = [];
  let [i1, j1, k1] = [0, 0, 0];

  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) {
        merged.push([i1, j1, k1]);
      }

      [i1, j1, k1] = [i2, j2, k2];
    }
  }

  if (k1) {
    merged.push([i1, j1, k1]);
  }

  return merged;
}

/**
 * Keep at most `context` equal lines before the first change and after the last.
 *
 * @param {Opcode[]} codes
 * @param {number} context
 * @returns {void}
 */
function trimOuterContext(codes, context) {
  const first = codes[0];

  if (first[0] === 'equal') {
    codes[0] = [
      'equal',
      Math.max(first[1], first[2] - context),
      first[2],
      Math.max(first[3], first[4] - context),
      first[4],
    ];
  }

  const last = /** @type {Opcode} */ (codes.at(-1));

  if (last[0] === 'equal') {
    codes[codes.length - 1] = [
      'equal',
      last[1],
      Math.min(last[2], last[1] + context),
      last[3],
      Math.min(last[4], last[3] + context),
    ];
  }
}

/**
 * Split at equal runs longer than twice the context.
 *
 * @param {Opcode[]} codes
 * @param {number} context
 * @returns {Opcode[][]}
 */
function splitIntoGroups(codes, context) {
  const span = context + context;
  /** @type {Opcode[][]} */
  const groups = [];
  /** @type {Opcode[]} */
  let group = [];

  for (const [tag, i1Start, i2, j1Start, j2] of codes) {
    let [i1, j1] = [i1Start, j1Start];

    if (tag === 'equal' && i2 - i1 > span) {
      group.push([tag, i1, Math.min(i2, i1 + context), j1, Math.min(j2, j1 + context)]);
      groups.push(group);
      group = [];
      [i1, j1] = [Math.max(i1, i2 - context), Math.max(j1, j2 - context)];
    }

    group.push([tag, i1, i2, j1, j2]);
  }

  if (group.length > 0 && !(group.length === 1 && group[0][0] === 'equal')) {
    groups.push(group);
  }

  return groups;
}

/**
 * @typedef {object} UnifiedDiffOptions
 * @property {string} [fromfile]
 * @property {string} [tofile]
 * @property {number} [context] Lines of context (`n`, default 3).
 * @property {string} [lineterm] Appended to the header lines (`lineterm`, default `\n`).
 */

/**
 * Python's `difflib.unified_diff(a, b, fromfile, tofile, n=context, lineterm=lineterm)` as an array
 * of lines (no file dates; the harness never passes them, so the headers stay stable across runs).
 *
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @param {UnifiedDiffOptions} [options]
 * @returns {string[]}
 */
export function unifiedDiff(a, b, { fromfile = '', tofile = '', context = 3, lineterm = '\n' } = {}) {
  const lines = [];

  for (const group of new SequenceMatcher(a, b).getGroupedOpcodes(context)) {
    if (lines.length === 0) {
      lines.push(`--- ${fromfile}${lineterm}`, `+++ ${tofile}${lineterm}`);
    }

    const first = group[0];
    const last = /** @type {Opcode} */ (group.at(-1));

    lines.push(`@@ -${formatRange(first[1], last[2])} +${formatRange(first[3], last[4])} @@${lineterm}`);
    lines.push(...hunkLines(group, a, b));
  }

  return lines;
}

/**
 * @param {Opcode[]} group
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {string[]}
 */
function hunkLines(group, a, b) {
  const lines = [];

  for (const [tag, i1, i2, j1, j2] of group) {
    if (tag === 'equal') {
      lines.push(...a.slice(i1, i2).map((line) => ` ${line}`));
      continue;
    }

    if (tag === 'replace' || tag === 'delete') {
      lines.push(...a.slice(i1, i2).map((line) => `-${line}`));
    }

    if (tag === 'replace' || tag === 'insert') {
      lines.push(...b.slice(j1, j2).map((line) => `+${line}`));
    }
  }

  return lines;
}

/**
 * A hunk range in "ed" format: `start` for one line, `start,length` otherwise; an empty range
 * starts at the line before it.
 *
 * @param {number} start
 * @param {number} stop
 * @returns {string}
 */
function formatRange(start, stop) {
  const length = stop - start;

  if (length === 1) {
    return String(start + 1);
  }

  return `${length === 0 ? start : start + 1},${length}`;
}
