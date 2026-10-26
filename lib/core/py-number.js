/**
 * Python's rules for numbers written as text: `str.isdigit()`, `int(text)`, `float(text)` and
 * float `sum()`.
 *
 * Stage: shared. The CLI (argparse's `type=int` options, the PR-number form of a run argument),
 * targets (browser versions in a target list), probe headers (`timeout:`, `repro:`), unified-diff
 * hunk headers, test logs, perf totals and scripts/check-checklists.js (item ids) all parse numbers
 * the way py-final did. Python's rules are Unicode-aware: `--keep ٣` and a target of `chrome ٨٠`
 * are accepted and `1_0` is 10, while JS's `Number` and `\d` know only ASCII digits.
 *
 * Invariant: every function reproduces CPython 3.14's result for the same input; where Python
 * raises ValueError, the function returns null (or, for `pyIntOrRaise`, throws).
 */
import { PY_WHITESPACE, pyStrip } from './py.js';

/**
 * Characters `str.isdigit()` accepts beyond the decimal digits (`\p{Nd}`): superscript,
 * subscript, circled and other digits of Unicode's Numeric_Type=Digit, which JS regexes cannot
 * name. Code point ranges, so the source stays ASCII.
 */
const OTHER_DIGIT_RANGES = [
  [0xb2, 0xb3],
  [0xb9, 0xb9],
  [0x1369, 0x1371],
  [0x19da, 0x19da],
  [0x2070, 0x2070],
  [0x2074, 0x2079],
  [0x2080, 0x2089],
  [0x2460, 0x2468],
  [0x2474, 0x247c],
  [0x2488, 0x2490],
  [0x24ea, 0x24ea],
  [0x24f5, 0x24fd],
  [0x24ff, 0x24ff],
  [0x2776, 0x277e],
  [0x2780, 0x2788],
  [0x278a, 0x2792],
  [0x10a40, 0x10a43],
  [0x10e60, 0x10e68],
  [0x11052, 0x1105a],
  [0x1f100, 0x1f10a],
];
const OTHER_DIGITS = OTHER_DIGIT_RANGES.map(
  ([first, last]) => `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`,
).join('');
const IS_DIGIT = new RegExp(`^[\\p{Nd}${OTHER_DIGITS}]+$`, 'u');
const SPACE = `[${RegExp.escape(PY_WHITESPACE)}]`;
/** What `int()` accepts: whitespace, a sign, decimal digits with single `_` between them. */
const INT_LITERAL = new RegExp(String.raw`^${SPACE}*([-+]?)(\p{Nd}+(?:_\p{Nd}+)*)${SPACE}*$`, 'u');
/** What `int(text, 16)` accepts once stripped: a sign, an optional `0x` prefix, hex digits. */
const HEX_LITERAL = /^([+-]?)(?:0[xX]_?)?([0-9a-fA-F]+(?:_[0-9a-fA-F]+)*)$/;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const RADIX = 10;
const HEX_RADIX = 16;

/**
 * The value of one Unicode decimal digit. Every script's digits are a contiguous run of ten
 * starting at zero (a Unicode stability guarantee; the mathematical digits are five such runs back
 * to back), so the value is the distance from the start of the run, modulo ten.
 *
 * @param {string} digit One code point that matches `\p{Nd}`.
 * @returns {number}
 */
export function digitValue(digit) {
  const codePoint = /** @type {number} */ (digit.codePointAt(0));
  let zero = codePoint;

  while (DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) {
    zero--;
  }

  return (codePoint - zero) % RADIX;
}

/**
 * Python's `text.isdigit()`: non-empty, and every character a digit.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function pyIsdigit(text) {
  return IS_DIGIT.test(text);
}

/**
 * Python's `int(text)`, or null where it raises ValueError.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function pyInt(text) {
  const match = INT_LITERAL.exec(text);

  if (!match) {
    return null;
  }

  let value = 0;

  for (const digit of match[2].replaceAll('_', '')) {
    value = value * RADIX + digitValue(digit);
  }

  // `0 - value`, not `-value`: Python has no negative zero.
  return match[1] === '-' ? 0 - value : value;
}

/**
 * Python's `int(text)` or `int(text, 16)` where py-final let the ValueError escape (a hunk header,
 * a test log's count): the same parse as `pyInt`, but invalid text throws, as a bug would.
 *
 * @param {string} text
 * @param {10 | 16} [base]
 * @returns {number}
 */
export function pyIntOrRaise(text, base = RADIX) {
  const value = base === HEX_RADIX ? hexInt(text) : pyInt(text);

  if (value === null) {
    throw new Error(`invalid literal for int() with base ${base}: '${text}'`);
  }

  return value;
}

/**
 * @param {string} text
 * @returns {number | null}
 */
function hexInt(text) {
  const match = HEX_LITERAL.exec(pyStrip(text));

  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[2].replaceAll('_', ''), HEX_RADIX);

  return match[1] === '-' ? 0 - value : value;
}

/**
 * Python's `int(text)` for a string of decimal digits from any script (what `\d+` matched).
 * Values beyond 2^53 come back as a BigInt so no digit is lost.
 *
 * @param {string} digits
 * @returns {number | bigint}
 */
export function pyDigitsToInt(digits) {
  const ascii = Array.from(digits, digitValue).join('');
  const value = BigInt(ascii);

  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

const PY_FLOAT_WORDS = /^[+-]?(?:inf|infinity|nan)$/i;
const DIGIT_PART = '\\d(?:_?\\d)*';
const PY_FLOAT_LITERAL = new RegExp(
  `^[+-]?(?:${DIGIT_PART}(?:\\.(?:${DIGIT_PART})?)?|\\.${DIGIT_PART})(?:[eE][+-]?${DIGIT_PART})?$`,
);

/**
 * Python's `float(text)`, or null where Python raises ValueError. Accepts what CPython accepts:
 * surrounding whitespace, a sign, digits from any script, `_` between digits, `inf`, `infinity`
 * and `nan` in any case.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function pyParseFloat(text) {
  const ascii = pyStrip(text).replace(/\p{Nd}/gu, (digit) => String(digitValue(digit)));

  if (PY_FLOAT_WORDS.test(ascii)) {
    return parseFloatWord(ascii);
  }

  if (!PY_FLOAT_LITERAL.test(ascii)) {
    return null;
  }

  return Number(ascii.replaceAll('_', ''));
}

/**
 * @param {string} word `[+-]inf`, `[+-]infinity` or `[+-]nan`.
 * @returns {number}
 */
function parseFloatWord(word) {
  if (/nan/i.test(word)) {
    return Number.NaN;
  }

  return word.startsWith('-') ? -Infinity : Infinity;
}

/**
 * Python's `sum()` of floats. Since 3.12 CPython adds floats with Neumaier's compensated
 * summation, so a naive left-to-right sum can differ in the last bit, and that bit can decide a
 * later `round()` (perf.json totals and ratios).
 *
 * @param {Iterable<number>} values
 * @returns {number}
 */
export function pySum(values) {
  let total = 0;
  let compensation = 0;

  for (const value of values) {
    const next = total + value;

    compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
    total = next;
  }

  // As CPython: a zero or non-finite compensation is not added (it would turn an overflowed sum
  // into NaN, or lose the sign of -0.0).
  return compensation !== 0 && Number.isFinite(compensation) ? total + compensation : total;
}
