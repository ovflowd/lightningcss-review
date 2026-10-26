/**
 * Python's `re` semantics for the patterns the stages match with.
 *
 * Stage: shared by prepare (diff and Rust source heuristics, linked-issue parsing), build (cargo
 * log parsing, the test-helper scanner, tuple mapping) and corpus (mutations, probe assertions).
 *
 * - `pyRe` compiles a regular expression written in Python's `re` syntax with Python's meaning:
 *   `\s \w \d \b` are Unicode-aware, `.` stops only at `\n`, `^`/`$` under MULTILINE see only
 *   `\n`, `$` also matches before a final `\n`, and IGNORECASE folds dotted/dotless i. The
 *   patterns keep the exact text and meaning they had when the formats they feed were fixed.
 * - `PY_SPACE`, `PY_WORD`, `PY_DIGIT`, … are the same classes as building blocks for patterns
 *   written in JavaScript syntax.
 *
 * Invariant: a pattern matches what CPython 3.14 matches on the same text, because the matches
 * land in prepare.json, build.json, case ids and probe results, which must stay stable so
 * baselines and earlier runs still match.
 */
import { PY_WHITESPACE } from './py.js';

/** Python's `\w` class body: letters, numbers (`str.isalnum()`) and `_`. */
const WORD = String.raw`\p{L}\p{N}_`;

/** Python's `\s` (`str.isspace()`), as a character class for `new RegExp(…, 'u')`. */
export const PY_SPACE = `[${PY_WHITESPACE}]`;

/** Python's `\S`. */
export const PY_NON_SPACE = `[^${PY_WHITESPACE}]`;

/** Python's `\w`: letters, numbers and `_`. */
export const PY_WORD = `[${WORD}]`;

/** Python's `\b` after a word character: the next character is not one. */
export const PY_WORD_END = `(?!${PY_WORD})`;

/** Python's `\b` before a word character: the previous character is not one. */
export const PY_WORD_START = `(?<!${PY_WORD})`;

/** Python's `\d`: any decimal digit (Unicode category Nd). */
export const PY_DIGIT = String.raw`\p{Nd}`;

const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
const NOT_BOUNDARY = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;

/**
 * A letter `i` under Python's `re.IGNORECASE`: Python also folds U+0130 and U+0131 (dotted capital
 * and dotless small i) to `i`; JavaScript's `iu` flags do not, so patterns spell them out.
 */
export const PY_CI_I = `[iI${String.fromCodePoint(0x130, 0x131)}]`;

/** Escapes outside a character class. */
const CLASS_ESCAPES = {
  s: PY_SPACE,
  S: PY_NON_SPACE,
  w: PY_WORD,
  W: `[^${WORD}]`,
  d: PY_DIGIT,
  D: String.raw`\P{Nd}`,
  b: BOUNDARY,
  B: NOT_BOUNDARY,
};

/** Escapes inside a character class (`[^\s]`, `[\w-]`). */
const IN_CLASS_ESCAPES = { s: PY_WHITESPACE, w: WORD, d: String.raw`\p{Nd}` };

/**
 * @typedef {object} TranslateState
 * @property {boolean} inClass
 * @property {boolean} multiline
 * @property {boolean} dotAll
 * @property {boolean} ignoreCase
 */

/**
 * Compile a Python `re` pattern. `flags` takes Python's letters in lower case (`m` MULTILINE,
 * `s` DOTALL, `i` IGNORECASE) plus JavaScript's `g` and `y`.
 *
 * @param {string} pattern Python syntax (write it with `String.raw`).
 * @param {string} [flags]
 * @returns {RegExp}
 */
export function pyRe(pattern, flags = '') {
  /** @type {TranslateState} */
  const state = {
    inClass: false,
    multiline: flags.includes('m'),
    dotAll: flags.includes('s'),
    ignoreCase: flags.includes('i'),
  };
  let source = '';

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === '\\') {
      source += translateEscape(pattern[++index], state);
    } else {
      source += translateChar(char, state);
    }
  }

  return new RegExp(source, `u${flags.replace('m', '')}`);
}

/**
 * @param {string} escaped The character after the backslash.
 * @param {TranslateState} state
 * @returns {string}
 */
function translateEscape(escaped, state) {
  const table = state.inClass ? IN_CLASS_ESCAPES : CLASS_ESCAPES;

  return Object.hasOwn(table, escaped) ? table[/** @type {keyof typeof table} */ (escaped)] : `\\${escaped}`;
}

/**
 * @param {string} char
 * @param {TranslateState} state
 * @returns {string}
 */
function translateChar(char, state) {
  if (state.inClass) {
    state.inClass = char !== ']';

    return char;
  }

  switch (char) {
    case '[':
      state.inClass = true;

      return char;
    case '.':
      return state.dotAll ? char : '[^\\n]';
    case '^':
      return state.multiline ? '(?<![^\\n])' : char;
    case '$':
      return state.multiline ? '(?![^\\n])' : String.raw`(?=\n?(?![\s\S]))`;
    case 'i':
    case 'I':
      return state.ignoreCase ? PY_CI_I : char;
    default:
      return char;
  }
}
