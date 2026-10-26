/**
 * A small scanner for Rust source: finds the helper functions of `mod tests` in src/lib.rs while
 * skipping strings, raw strings, char literals and comments, so a `{` inside `"a { b }"` or
 * `r#"{ unbalanced "#` never unbalances the brace matching.
 *
 * Stage: build (test-tuple recorder injection, inject.js). Offsets are UTF-16 indices into the
 * text; the injector only slices and inserts at them, so the unit does not matter.
 *
 * Invariant: the heuristics are frozen, quirks included (a `b"` at offset 0 looks at the last
 * character of the file, as a Python `t[-1]` would), because the helpers it finds decide which
 * calls are recorded, and so which tuples, cases and case ids a run has: a change here would make
 * baselines and earlier runs stop matching.
 */
import { LcrError } from '../core/errors.js';
import { pyRe } from '../core/py-re.js';
import { pySplit, pyStrip } from '../core/py.js';

/** Python's `str.isalnum()` for one code point (letters and numbers of any script). */
const ALPHANUMERIC = /^[\p{L}\p{N}]$/u;
const RAW_STRING_START = /b?r(#*)"/y;
const CHAR_LITERAL = pyRe(String.raw`'(\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'`, 'y');
const MOD_TESTS = pyRe(String.raw`^#\[cfg\(test\)\]\s*\nmod tests \{`, 'm');
const FN_HEADER = pyRe(String.raw`fn\s+([a-z_][a-z0-9_]*)\s*(<[^{(]*>)?\s*\(`, 'y');

/**
 * @typedef {object} Helper A direct child `fn` of `mod tests`.
 * @property {string} name
 * @property {number} fnStart Offset of `fn`.
 * @property {[name: string, type: string][]} params
 * @property {number} bodyOpen Offset of the body's `{`.
 * @property {number} bodyClose Offset of the body's `}`.
 * @property {number} attrsStart Offset of the first attribute line belonging to the fn.
 * @property {boolean} hasTrackCaller
 * @property {boolean} isTest
 */

/** Finds structure in Rust source while skipping strings, chars and comments. */
export class RustScanner {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.length = text.length;
  }

  /**
   * Python's `t[i - 1]` test for "an identifier character precedes `index`" (index 0 wraps to the
   * last character, as a negative Python index does).
   *
   * @param {number} index
   * @returns {boolean}
   */
  identifierBefore(index) {
    const char = codePointBefore(this.text, index === 0 ? this.length : index);

    return char === '_' || ALPHANUMERIC.test(char);
  }

  /**
   * If a string, char literal or comment starts at `index`, the offset after it; else `index`.
   *
   * @param {number} index
   * @returns {number}
   */
  skipLiteral(index) {
    const text = this.text;

    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);

      return end < 0 ? this.length : end;
    }

    if (text.startsWith('/*', index)) {
      return this.skipBlockComment(index);
    }

    RAW_STRING_START.lastIndex = index;

    const raw = RAW_STRING_START.exec(text);

    if (raw && (index === 0 || !this.identifierBefore(index))) {
      return this.skipRawString(raw);
    }

    const char = text[index];

    if (char === '"' || (char === 'b' && text.startsWith('b"', index) && !this.identifierBefore(index))) {
      return this.skipString(index + (char === 'b' ? 2 : 1));
    }

    if (char === "'") {
      // A char literal ('a', '\n', '\u{1F600}', '\'') or a lifetime ('a).
      CHAR_LITERAL.lastIndex = index;

      return CHAR_LITERAL.exec(text) ? CHAR_LITERAL.lastIndex : index + 1;
    }

    return index;
  }

  /**
   * Block comments nest in Rust.
   *
   * @param {number} index
   * @returns {number}
   */
  skipBlockComment(index) {
    let depth = 1;
    let next = index + 2;

    while (next < this.length && depth > 0) {
      if (this.text.startsWith('/*', next)) {
        depth++;
        next += 2;
      } else if (this.text.startsWith('*/', next)) {
        depth--;
        next += 2;
      } else {
        next++;
      }
    }

    return next;
  }

  /**
   * @param {RegExpExecArray} start The `r#"` match.
   * @returns {number}
   */
  skipRawString(start) {
    const terminator = `"${start[1]}`;
    const end = this.text.indexOf(terminator, start.index + start[0].length);

    if (end < 0) {
      throw new LcrError('unterminated raw string in src/lib.rs');
    }

    return end + terminator.length;
  }

  /**
   * @param {number} index First offset inside the quotes.
   * @returns {number}
   */
  skipString(index) {
    let next = index;

    while (next < this.length) {
      if (this.text[next] === '\\') {
        next += 2;
      } else if (this.text[next] === '"') {
        return next + 1;
      } else {
        next++;
      }
    }

    throw new LcrError('unterminated string in src/lib.rs');
  }

  /**
   * The offset of the bracket that closes the one at `openAt`.
   *
   * @param {number} openAt
   * @param {{ open?: string, close?: string }} [brackets] Default `{` and `}`.
   * @returns {number}
   */
  matchBrace(openAt, { open = '{', close = '}' } = {}) {
    let depth = 0;
    let index = openAt;

    while (index < this.length) {
      const skipped = this.skipLiteral(index);

      if (skipped !== index) {
        index = skipped;
        continue;
      }

      const char = this.text[index];

      if (char === open) {
        depth++;
      } else if (char === close && --depth === 0) {
        return index;
      }

      index++;
    }

    throw new LcrError(`unbalanced ${open}${close} in src/lib.rs`);
  }
}

/**
 * The code point that ends just before `index` (a whole surrogate pair when there is one).
 *
 * @param {string} text
 * @param {number} index
 * @returns {string}
 */
function codePointBefore(text, index) {
  const low = text.charCodeAt(index - 1);
  const isLowSurrogate = low >= 0xdc00 && low <= 0xdfff;

  return isLowSurrogate && index >= 2 ? text.slice(index - 2, index) : text.slice(index - 1, index);
}

/**
 * Split a parameter list into `[name, type]` pairs (types with whitespace collapsed). Commas
 * inside `<>`, `()` and `[]` do not split; parameters without a `:` (`self`) are dropped.
 *
 * @param {string} text
 * @returns {[name: string, type: string][]}
 */
export function splitParams(text) {
  const raw = [];
  let depth = 0;
  let current = '';

  for (const char of text) {
    if ('<(['.includes(char)) {
      depth++;
    } else if ('>)]'.includes(char)) {
      depth--;
    }

    if (char === ',' && depth === 0) {
      raw.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (pyStrip(current)) {
    raw.push(current);
  }

  /** @type {[string, string][]} */
  const params = [];

  for (const param of raw.map((part) => pyStrip(part))) {
    if (!param || !param.includes(':')) {
      continue;
    }

    const [name, type] = pySplit(param, ':', 1);
    const bare = pyStrip(pyStrip(name).replace(/^mut /, ''));

    params.push([bare, pySplit(type).join(' ')]);
  }

  return params;
}

/**
 * The direct child functions of `#[cfg(test)] mod tests { … }` in src/lib.rs.
 *
 * @param {string} text
 * @returns {{ modOpen: number, modClose: number, helpers: Helper[] }}
 */
export function findHelpers(text) {
  const scanner = new RustScanner(text);
  const mod = MOD_TESTS.exec(text);

  if (!mod) {
    throw new LcrError('could not find `#[cfg(test)] mod tests {` in src/lib.rs');
  }

  const modOpen = mod.index + mod[0].length - 1;
  const modClose = scanner.matchBrace(modOpen);
  /** @type {Helper[]} */
  const helpers = [];
  let index = modOpen + 1;

  // Walk the module's top-level items only: any other `{ … }` (impl, nested mod) is skipped whole.
  while (index < modClose) {
    const skipped = scanner.skipLiteral(index);

    if (skipped !== index) {
      index = skipped;
    } else if (text[index] === '{') {
      index = scanner.matchBrace(index) + 1;
    } else {
      const helper = helperAt(scanner, index, modOpen);

      if (helper) {
        helpers.push(helper);
        index = helper.bodyClose + 1;
      } else {
        index++;
      }
    }
  }

  return { modOpen, modClose, helpers };
}

/**
 * The function whose `fn` keyword starts at `index`, or null.
 *
 * @param {RustScanner} scanner
 * @param {number} index
 * @param {number} modOpen
 * @returns {Helper | null}
 */
function helperAt(scanner, index, modOpen) {
  const text = scanner.text;

  FN_HEADER.lastIndex = index;

  const header = FN_HEADER.exec(text);

  if (!header || (index !== 0 && scanner.identifierBefore(index))) {
    return null;
  }

  const parenOpen = FN_HEADER.lastIndex - 1;
  const parenClose = scanner.matchBrace(parenOpen, { open: '(', close: ')' });
  const bodyOpen = text.indexOf('{', parenClose);

  if (bodyOpen < 0) {
    // Not a layout rustc accepts in a module, so a bug in the scanner rather than a finding.
    throw new Error(`no body after the parameters of fn ${header[1]} in src/lib.rs`);
  }

  const lineStart = lastNewline(text, index) + 1;
  const attrsStart = attributesStart(text, lineStart, modOpen);
  const attrs = text.slice(attrsStart, lineStart);

  return {
    name: header[1],
    fnStart: index,
    params: splitParams(text.slice(parenOpen + 1, parenClose)),
    bodyOpen,
    bodyClose: scanner.matchBrace(bodyOpen),
    attrsStart,
    hasTrackCaller:
      attrs.includes('#[track_caller]') || text.slice(lineStart, index).includes('#[track_caller]'),
    isTest: attrs.includes('#[test]'),
  };
}

/**
 * The offset of the last newline before `end`, or -1.
 *
 * @param {string} text
 * @param {number} end
 * @returns {number}
 */
function lastNewline(text, end) {
  return end <= 0 ? -1 : text.lastIndexOf('\n', end - 1);
}

/**
 * The start of the contiguous `#[…]` attribute lines directly above `lineStart` (not above the
 * module's own `{`).
 *
 * @param {string} text
 * @param {number} lineStart
 * @param {number} modOpen
 * @returns {number}
 */
function attributesStart(text, lineStart, modOpen) {
  let start = lineStart;

  for (;;) {
    const previousEnd = start - 1;

    if (previousEnd <= modOpen) {
      return start;
    }

    const previousStart = lastNewline(text, previousEnd) + 1;

    if (!pyStrip(text.slice(previousStart, previousEnd)).startsWith('#[')) {
      return start;
    }

    start = previousStart;
  }
}
