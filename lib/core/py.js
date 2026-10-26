/**
 * Python semantics the harness output depends on.
 *
 * Stage: shared, mostly by the text renderers (report, summary, brief, table, show, status). Their
 * formats come from the original Python implementation (tag `py-final`) and are frozen, because
 * reviewers diff report.md, report.json and the summary between runs. That text prints Python
 * values: `str(None)` is `None`, a dict prints as `{'a': 1}`, `len()` and slicing count code
 * points, `str.split()` and `strip()` use Python's whitespace set, `f"{x:+.3%}"` rounds half to
 * even on the exact binary value, `sorted()` orders strings by code point, and `fnmatch` has its
 * own glob dialect. Each helper here reproduces one of those exactly, so the text stays
 * byte-identical from one version to the next.
 *
 * Invariant: these helpers are pure and deterministic; none of them depends on the locale.
 */
import { compareCodePoints, isPyFloat, PyFloat, pyFloat, pyFloatRepr } from './pyjson.js';

export { compareCodePoints, pyFloat, pyFloatRepr, PyFloat };

/** @import { PyNumber } from './pyjson.js' */

/** Integers below this magnitude print as Python ints (see pyjson.js). */
const PY_INT_PRINT_LIMIT = 1e16;

// ---------------------------------------------------------------------------------------------
// repr / str / truthiness

/**
 * Python's `repr(value)` for the JSON-like values the harness handles: `None`, `True`, ints,
 * floats, strings, lists (arrays), dicts (plain objects and `Map`s, in insertion order).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function pyRepr(value) {
  if (value === null || value === undefined) {
    return 'None';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'True' : 'False';
    case 'number':
      return numberRepr(value);
    case 'bigint':
      return value.toString();
    case 'string':
      return stringRepr(value);
    default:
      return containerRepr(/** @type {object} */ (value));
  }
}

/**
 * @param {object} value
 * @returns {string}
 */
function containerRepr(value) {
  if (value instanceof PyFloat) {
    return pyFloatRepr(value.value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(pyRepr).join(', ')}]`;
  }

  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);

  return `{${entries.map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(', ')}}`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function numberRepr(value) {
  return Number.isInteger(value) && Math.abs(value) < PY_INT_PRINT_LIMIT ? String(value) : pyFloatRepr(value);
}

// Python's str.isprintable() is false for these categories (space excepted); repr escapes them.
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const SHORT_ESCAPES = /** @type {Record<string, string>} */ ({
  '\\': '\\\\',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
});

/**
 * Python's `repr(str)`: single quotes unless the text has a single quote and no double quote,
 * `\t \n \r \\` short escapes, `\xhh` / `\uhhhh` / `\Uhhhhhhhh` for non-printable characters.
 *
 * @param {string} text
 * @returns {string}
 */
function stringRepr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;

  for (const char of text) {
    out += escapeReprChar(char, quote);
  }

  return out + quote;
}

/**
 * @param {string} char One code point.
 * @param {string} quote The quote the repr uses.
 * @returns {string}
 */
function escapeReprChar(char, quote) {
  if (char === quote) {
    return `\\${char}`;
  }

  if (Object.hasOwn(SHORT_ESCAPES, char)) {
    return SHORT_ESCAPES[char];
  }

  if (char === ' ' || !NOT_PRINTABLE.test(char)) {
    return char;
  }

  const code = /** @type {number} */ (char.codePointAt(0));

  if (code < 0x100) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }

  return code < 0x10000
    ? `\\u${code.toString(16).padStart(4, '0')}`
    : `\\U${code.toString(16).padStart(8, '0')}`;
}

/**
 * Python's `str(value)`: strings unchanged, everything else as `pyRepr` (that is what `str()` of
 * None, bools, numbers, lists and dicts gives). Use it wherever a value is interpolated into
 * fixed-format text, so a missing value prints as `None` rather than `null` or `undefined`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function pyStr(value) {
  return typeof value === 'string' ? value : pyRepr(value);
}

/**
 * Python truthiness (`bool(value)`): empty lists, dicts and strings, `0`, `0.0` and `None` are
 * false; `NaN` is true. JavaScript treats `[]` and `{}` as true, which is the classic mistake.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function pyTruthy(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value !== 'object') {
    return Boolean(value);
  }

  if (value instanceof PyFloat) {
    return value.value !== 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (value instanceof Map || value instanceof Set) {
    return value.size > 0;
  }

  return Object.keys(value).length > 0;
}

// ---------------------------------------------------------------------------------------------
// Exact decimal rounding (round(), format specs)

const FLOAT64_EXPONENT_BIAS = 1075;
const FLOAT64_MANTISSA_BITS = 52n;
const FLOAT64_IMPLICIT_BIT = 1n << FLOAT64_MANTISSA_BITS;
const FLOAT64_EXPONENT_MASK = 0x7ff;

/**
 * The exact value of a finite double as mantissa * 2^exponent (mantissa a non-negative BigInt).
 *
 * @param {number} value
 * @returns {{ negative: boolean, mantissa: bigint, exponent: number }}
 */
function exactBinary(value) {
  const view = new DataView(new ArrayBuffer(8));

  view.setFloat64(0, value);

  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const biased = Number((bits >> FLOAT64_MANTISSA_BITS) & BigInt(FLOAT64_EXPONENT_MASK));
  const fraction = bits & (FLOAT64_IMPLICIT_BIT - 1n);

  if (biased === 0) {
    // Subnormal: no implicit leading bit, fixed exponent.
    return { negative, mantissa: fraction, exponent: 1 - FLOAT64_EXPONENT_BIAS };
  }

  return { negative, mantissa: fraction | FLOAT64_IMPLICIT_BIT, exponent: biased - FLOAT64_EXPONENT_BIAS };
}

/**
 * Round |value| * 10^places to an integer, half to even, on the exact binary value.
 *
 * @param {number} value A finite double.
 * @param {number} places Decimal places to keep (may be negative).
 * @returns {{ negative: boolean, scaled: bigint }}
 */
function roundScaled(value, places) {
  const { negative, mantissa, exponent } = exactBinary(value);
  let numerator = mantissa;
  let denominator = 1n;

  if (exponent >= 0) {
    numerator <<= BigInt(exponent);
  } else {
    denominator <<= BigInt(-exponent);
  }

  if (places >= 0) {
    numerator *= 10n ** BigInt(places);
  } else {
    denominator *= 10n ** BigInt(-places);
  }

  const quotient = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  const roundUp = twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n === 1n);

  return { negative, scaled: roundUp ? quotient + 1n : quotient };
}

/**
 * The digits of |value| rounded to `places` decimals, half to even (Python's `'%.Nf'` digits).
 *
 * @param {number} value A finite double.
 * @param {number} places Non-negative.
 * @returns {{ negative: boolean, text: string }}
 */
function fixedDigits(value, places) {
  const { negative, scaled } = roundScaled(value, places);
  const digits = scaled.toString().padStart(places + 1, '0');
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;

  return { negative, text };
}

// Beyond these, Python's round(x, n) returns x unchanged (or a signed zero).
const ROUND_NDIGITS_MAX = 323;
const ROUND_NDIGITS_MIN = -308;

/**
 * Python's `round(x)` (an int, half to even; a BigInt from 1e16 up) and `round(x, ndigits)` (a
 * float, correctly rounded half to even on the exact binary value, as CPython does). Pass floats
 * only: `round(int, n)` is an int in Python and needs no rounding.
 *
 * @overload
 * @param {number | PyFloat} value
 * @returns {number | bigint}
 */
/**
 * @overload
 * @param {number | PyFloat} value
 * @param {number} ndigits
 * @returns {PyNumber}
 */
/**
 * Implementation of the overloads above.
 *
 * @param {number | PyFloat} value
 * @param {number} [ndigits]
 * @returns {PyNumber | bigint}
 */
export function pyRound(value, ndigits) {
  const number = Number(value);

  if (ndigits === undefined) {
    return roundToInt(number);
  }

  if (!Number.isFinite(number) || ndigits > ROUND_NDIGITS_MAX) {
    return pyFloat(number);
  }

  if (ndigits < ROUND_NDIGITS_MIN) {
    return pyFloat(0 * number);
  }

  const { negative, scaled } = roundScaled(number, ndigits);
  const magnitude = Number(`${scaled}e${-ndigits}`);

  return pyFloat(negative ? -magnitude : magnitude);
}

/**
 * @param {number} value
 * @returns {number | bigint} A BigInt when the int is too large to print as one from a number.
 */
function roundToInt(value) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cannot convert float ${pyFloatRepr(value)} to integer`);
  }

  const { negative, scaled } = roundScaled(value, 0);
  const signed = negative ? -scaled : scaled;

  // Python ints have no negative zero; Number(0n) is +0.
  return scaled < BigInt(PY_INT_PRINT_LIMIT) ? Number(signed) : signed;
}

// ---------------------------------------------------------------------------------------------
// format() / f-string specs / str.format

const FORMAT_SPEC = /^(?:(.)?([<>=^]))?([-+ ])?(0)?(\d+)?(,)?(?:\.(\d+))?([sdf%])?$/su;

/**
 * Python's `format(value, spec)` for the specs the harness uses: fill/align/width (`<12`, `>8`,
 * `^5`, `9`), sign, zero padding, `,` grouping, precision, and the types `s`, `d`, `f` and `%`.
 * Widths count code points. Other spec letters throw, so a gap is found instead of misprinted.
 *
 * @param {unknown} value
 * @param {string} spec
 * @returns {string}
 */
export function pyFormat(value, spec) {
  if (spec === '') {
    return pyStr(value);
  }

  const match = FORMAT_SPEC.exec(spec);

  if (!match) {
    throw new RangeError(`unsupported format spec ${pyRepr(spec)}`);
  }

  const [, fill, align, sign, zero, width, grouping, precision, type] = match;
  const parsed = { fill, align, sign, zero, width, grouping, precision, type };

  if (typeof value === 'string') {
    return formatString(value, parsed);
  }

  return formatNumber(value, parsed);
}

/**
 * @typedef {object} ParsedSpec
 * @property {string | undefined} fill
 * @property {string | undefined} align
 * @property {string | undefined} sign
 * @property {string | undefined} zero
 * @property {string | undefined} width
 * @property {string | undefined} grouping
 * @property {string | undefined} precision
 * @property {string | undefined} type
 */

/**
 * @param {string} value
 * @param {ParsedSpec} spec
 * @returns {string}
 */
function formatString(value, spec) {
  if (spec.type !== undefined && spec.type !== 's') {
    throw new RangeError(`Unknown format code '${spec.type}' for object of type 'str'`);
  }

  const text = spec.precision === undefined ? value : pySlice(value, 0, Number(spec.precision));

  return pad('', text, spec, '<');
}

/**
 * @param {unknown} value
 * @param {ParsedSpec} spec
 * @returns {string}
 */
function formatNumber(value, spec) {
  // bool.__format__ with a non-empty spec formats the int.
  const number = typeof value === 'boolean' ? Number(value) : value;

  if (!isNumeric(number)) {
    throw new TypeError(`unsupported format string passed to ${pyTypeName(value)}.__format__`);
  }

  const { negative, body } = numberBody(/** @type {number | bigint | PyFloat} */ (number), spec);
  const signText = negative ? '-' : signFor(spec.sign);
  const grouped = spec.grouping ? groupThousands(body) : body;

  if (spec.zero && spec.align === undefined) {
    return pad(signText, grouped, { ...spec, fill: '0', align: '=' }, '>');
  }

  return pad(signText, grouped, spec, '>');
}

/**
 * The unsigned digits of a number under a spec's type and precision.
 *
 * @param {number | bigint | PyFloat} value
 * @param {ParsedSpec} spec
 * @returns {{ negative: boolean, body: string }}
 */
function numberBody(value, spec) {
  if (typeof value === 'bigint') {
    return { negative: value < 0n, body: (value < 0n ? -value : value).toString() };
  }

  const number = Number(value);
  const isFloat = isPyFloat(value) || !isPyInt(number);
  const type = spec.type ?? (isFloat ? 'repr' : 'd');

  if (type === 'd') {
    if (isFloat) {
      throw new RangeError("Unknown format code 'd' for object of type 'float'");
    }

    return { negative: number < 0, body: String(Math.abs(number)) };
  }

  if (type === 'repr') {
    if (spec.precision !== undefined) {
      throw new RangeError('format specs with a precision and no type are not supported');
    }

    return { negative: number < 0 || Object.is(number, -0), body: pyFloatRepr(Math.abs(number)) };
  }

  return fixedBody(number, type, spec.precision === undefined ? DEFAULT_PRECISION : Number(spec.precision));
}

const DEFAULT_PRECISION = 6;

/**
 * `f` and `%` bodies: exact decimal rounding, half to even.
 *
 * @param {number} number
 * @param {string} type
 * @param {number} places
 * @returns {{ negative: boolean, body: string }}
 */
function fixedBody(number, type, places) {
  const suffix = type === '%' ? '%' : '';

  if (!Number.isFinite(number)) {
    return { negative: number < 0, body: (Number.isNaN(number) ? 'nan' : 'inf') + suffix };
  }

  // `%` multiplies by 100 in floating point first, exactly as CPython does.
  const { negative, text } = fixedDigits(type === '%' ? number * 100 : number, places);

  return { negative, body: text + suffix };
}

/**
 * @param {string | undefined} sign
 * @returns {string}
 */
function signFor(sign) {
  if (sign === '+') {
    return '+';
  }

  return sign === ' ' ? ' ' : '';
}

/**
 * @param {string} body
 * @returns {string}
 */
function groupThousands(body) {
  const [integer, fraction] = body.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * @param {string} signText
 * @param {string} body
 * @param {ParsedSpec} spec
 * @param {string} defaultAlign `<` for strings, `>` for numbers.
 * @returns {string}
 */
function pad(signText, body, spec, defaultAlign) {
  const width = spec.width === undefined ? 0 : Number(spec.width);
  const missing = width - pyLen(signText + body);

  if (missing <= 0) {
    return signText + body;
  }

  const fill = spec.fill ?? ' ';
  const align = spec.align ?? defaultAlign;

  if (align === '=') {
    return signText + fill.repeat(missing) + body;
  }

  if (align === '<') {
    return signText + body + fill.repeat(missing);
  }

  if (align === '>') {
    return fill.repeat(missing) + signText + body;
  }

  const left = Math.floor(missing / 2);

  return fill.repeat(left) + signText + body + fill.repeat(missing - left);
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function isPyInt(value) {
  return Number.isInteger(value) && Math.abs(value) < PY_INT_PRINT_LIMIT;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function pyTypeName(value) {
  if (value === null || value === undefined) {
    return 'NoneType';
  }

  return Array.isArray(value) ? 'list' : typeof value;
}

const TEMPLATE_FIELD = /\{\{|\}\}|\{([A-Za-z_]\w*)(?:!([rs]))?(?::([^{}]*))?\}/g;

/**
 * Python's `template.format(**values)` with named fields: `{name}`, `{name:spec}`, `{name!r}`, and
 * `{{` / `}}` for literal braces. A field without a value throws, as Python raises KeyError.
 *
 * @param {string} template
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
export function formatTemplate(template, values) {
  return template.replace(TEMPLATE_FIELD, (token, name, conversion, spec) => {
    if (token === '{{') {
      return '{';
    }

    if (token === '}}') {
      return '}';
    }

    if (!Object.hasOwn(values, name)) {
      throw new RangeError(`template field ${pyRepr(name)} has no value`);
    }

    const value = conversion === 'r' ? pyRepr(values[name]) : values[name];

    return pyFormat(conversion === 's' ? pyStr(value) : value, spec ?? '');
  });
}

// ---------------------------------------------------------------------------------------------
// Ordering

/**
 * Python's `<` ordering for sort keys: numbers (bools count as 0/1), strings by code point, and
 * arrays (tuples) element by element. `None` equals `None`; comparing it with anything else, or
 * mixing strings and numbers, throws a TypeError as Python does.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
export function pyCompare(left, right) {
  if (typeof left === 'string' && typeof right === 'string') {
    return compareCodePoints(left, right);
  }

  if (isNumeric(left) && isNumeric(right)) {
    return Math.sign(Number(left) - Number(right));
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return compareSequences(left, right);
  }

  if (left === null && right === null) {
    return 0;
  }

  throw new TypeError(`'<' not supported between ${pyTypeName(left)} and ${pyTypeName(right)}`);
}

/**
 * @param {unknown[]} left
 * @param {unknown[]} right
 * @returns {number}
 */
function compareSequences(left, right) {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index++) {
    // Python compares tuples with == first, so equal None elements never reach `<`.
    if (left[index] === right[index]) {
      continue;
    }

    const order = pyCompare(left[index], right[index]);

    if (order !== 0) {
      return order;
    }
  }

  return left.length - right.length;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumeric(value) {
  return (
    typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || isPyFloat(value)
  );
}

/**
 * Python's `sorted(items, key=key, reverse=reverse)`: stable, ordered by `pyCompare`. With
 * `reverse`, equal items keep their original order, as in Python.
 *
 * @template T
 * @param {Iterable<T>} items
 * @param {(item: T) => unknown} [key]
 * @param {{ reverse?: boolean }} [options]
 * @returns {T[]}
 */
export function pySorted(items, key = (item) => item, { reverse = false } = {}) {
  const decorated = [...items].map((item, index) => ({ item, index, sortKey: key(item) }));
  const direction = reverse ? -1 : 1;

  decorated.sort((a, b) => direction * pyCompare(a.sortKey, b.sortKey) || a.index - b.index);

  return decorated.map(({ item }) => item);
}

// ---------------------------------------------------------------------------------------------
// Strings: code points and Python's whitespace

/** The characters Python's `str.isspace()` accepts (JavaScript's `\s` differs in four places). */
export const PY_WHITESPACE =
  '\t\n\u000b\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';

const WHITESPACE_RUN = new RegExp(`[${PY_WHITESPACE}]+`, 'u');
const SURROGATE = /[\ud800-\udfff]/;

/**
 * Python's `len(text)`: code points, not UTF-16 units.
 *
 * @param {string} text
 * @returns {number}
 */
export function pyLen(text) {
  if (!SURROGATE.test(text)) {
    return text.length;
  }

  let count = 0;

  for (const _char of text) {
    count++;
  }

  return count;
}

/**
 * Python's `text[start:end]`: code-point indices, negative values count from the end.
 *
 * @param {string} text
 * @param {number} [start]
 * @param {number} [end]
 * @returns {string}
 */
export function pySlice(text, start, end) {
  if (!SURROGATE.test(text)) {
    return text.slice(start, end);
  }

  return Array.from(text).slice(start, end).join('');
}

/**
 * @param {string | undefined} chars
 * @returns {Set<string>}
 */
function stripSet(chars) {
  return new Set(chars === undefined ? PY_WHITESPACE : chars);
}

/**
 * Python's `text.strip(chars)`; without `chars`, Python's whitespace.
 *
 * @param {string} text
 * @param {string} [chars]
 * @returns {string}
 */
export function pyStrip(text, chars) {
  return pyRstrip(pyLstrip(text, chars), chars);
}

/**
 * Python's `text.lstrip(chars)`.
 *
 * @param {string} text
 * @param {string} [chars]
 * @returns {string}
 */
export function pyLstrip(text, chars) {
  const strip = stripSet(chars);
  const codePoints = Array.from(text);
  let start = 0;

  while (start < codePoints.length && strip.has(codePoints[start])) {
    start++;
  }

  return codePoints.slice(start).join('');
}

/**
 * Python's `text.rstrip(chars)`.
 *
 * @param {string} text
 * @param {string} [chars]
 * @returns {string}
 */
export function pyRstrip(text, chars) {
  const strip = stripSet(chars);
  const codePoints = Array.from(text);
  let end = codePoints.length;

  while (end > 0 && strip.has(codePoints[end - 1])) {
    end--;
  }

  return codePoints.slice(0, end).join('');
}

/**
 * Python's `text.split(sep, maxsplit)`. Without `sep`: split on runs of Python whitespace and drop
 * empty strings. With `maxsplit`, the remainder stays in the last item (unlike JS's `limit`).
 *
 * @param {string} text
 * @param {string | null} [sep]
 * @param {number} [maxsplit]
 * @returns {string[]}
 */
export function pySplit(text, sep = null, maxsplit = -1) {
  if (sep === null) {
    return splitWhitespace(text, maxsplit);
  }

  if (sep === '') {
    throw new RangeError('empty separator');
  }

  const parts = text.split(sep);

  if (maxsplit < 0 || parts.length <= maxsplit + 1) {
    return parts;
  }

  return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)];
}

/**
 * CPython's `split_whitespace`: tokens between runs of whitespace; once `maxsplit` tokens are cut,
 * the remainder (leading whitespace skipped, trailing kept) is the last item.
 *
 * @param {string} text
 * @param {number} maxsplit
 * @returns {string[]}
 */
function splitWhitespace(text, maxsplit) {
  const parts = [];
  let rest = text;

  while (maxsplit < 0 || parts.length < maxsplit) {
    rest = pyLstrip(rest);

    if (rest === '') {
      return parts;
    }

    const match = WHITESPACE_RUN.exec(rest);
    const end = match ? match.index : rest.length;

    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }

  rest = pyLstrip(rest);

  if (rest !== '') {
    parts.push(rest);
  }

  return parts;
}

// eslint-disable-next-line no-control-regex -- VT, FS, GS and RS end lines in Python
const LINE_BOUNDARY = /\r\n|[\n\r\u000b\f\u001c\u001d\u001e\u0085\u2028\u2029]/;

/**
 * Python's `text.splitlines()`: every Unicode line boundary, no trailing empty item.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function pySplitlines(text) {
  if (text === '') {
    return [];
  }

  const lines = text.split(new RegExp(LINE_BOUNDARY, 'g'));

  // A trailing boundary ends the last line; it does not start an empty one.
  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

// ---------------------------------------------------------------------------------------------
// fnmatch

/** @type {Map<string, RegExp>} */
const FNMATCH_CACHE = new Map();

/**
 * Python's `fnmatch.fnmatchcase(name, pattern)`: `*` matches anything (including `/`), `?` one
 * character, `[seq]` / `[!seq]` a set; there is no escaping. On POSIX, `fnmatch.fnmatch` is the
 * same function.
 *
 * @param {string} name
 * @param {string} pattern
 * @returns {boolean}
 */
export function fnmatchcase(name, pattern) {
  let regex = FNMATCH_CACHE.get(pattern);

  if (!regex) {
    regex = new RegExp(`^(?:${fnmatchTranslate(pattern)})$`, 'su');
    FNMATCH_CACHE.set(pattern, regex);
  }

  return regex.test(name);
}

/**
 * The body of the regular expression `fnmatch.translate` builds (CPython 3.14's algorithm,
 * rendered in JavaScript regex syntax).
 *
 * @param {string} pattern
 * @returns {string}
 */
export function fnmatchTranslate(pattern) {
  const parts = [];
  const chars = Array.from(pattern);
  let index = 0;

  while (index < chars.length) {
    const char = chars[index++];

    if (char === '*') {
      parts.push('.*');

      while (chars[index] === '*') {
        index++;
      }
    } else if (char === '?') {
      parts.push('.');
    } else if (char === '[') {
      const set = translateSet(chars, index);

      parts.push(set.regex);
      index = set.next;
    } else {
      parts.push(RegExp.escape(char));
    }
  }

  return parts.join('');
}

/**
 * Translate the bracket expression whose content starts at `start` (just after `[`).
 *
 * @param {string[]} chars
 * @param {number} start
 * @returns {{ regex: string, next: number }}
 */
function translateSet(chars, start) {
  let end = start;

  if (chars[end] === '!') {
    end++;
  }

  if (chars[end] === ']') {
    end++;
  }

  while (end < chars.length && chars[end] !== ']') {
    end++;
  }

  if (end >= chars.length) {
    return { regex: '\\[', next: start };
  }

  const negated = chars[start] === '!';

  return { regex: renderSet(setChunks(chars, start, end), negated), next: end + 1 };
}

/**
 * The set split at range hyphens, with empty ranges removed (CPython's `chunks`).
 *
 * @param {string[]} chars
 * @param {number} start
 * @param {number} end
 * @returns {string[]}
 */
function setChunks(chars, start, end) {
  const negated = chars[start] === '!';
  const body = chars.slice(negated ? start + 1 : start, end);

  if (!body.includes('-')) {
    return [body.join('')];
  }

  const chunks = [];
  let chunkStart = 0;
  let search = 1;

  for (;;) {
    const hyphen = body.indexOf('-', search);

    if (hyphen < 0) {
      break;
    }

    chunks.push(body.slice(chunkStart, hyphen).join(''));
    chunkStart = hyphen + 1;
    search = hyphen + 3;
  }

  const last = body.slice(chunkStart).join('');

  if (last) {
    chunks.push(last);
  } else {
    chunks[chunks.length - 1] += '-';
  }

  return removeEmptyRanges(chunks);
}

/**
 * @param {string[]} chunks
 * @returns {string[]}
 */
function removeEmptyRanges(chunks) {
  for (let index = chunks.length - 1; index > 0; index--) {
    const previous = Array.from(chunks[index - 1]);
    const current = Array.from(chunks[index]);

    if (compareCodePoints(/** @type {string} */ (previous.at(-1)), current[0]) > 0) {
      chunks[index - 1] = previous.slice(0, -1).join('') + current.slice(1).join('');
      chunks.splice(index, 1);
    }
  }

  return chunks;
}

/**
 * @param {string[]} chunks
 * @param {boolean} negated
 * @returns {string}
 */
function renderSet(chunks, negated) {
  const escapeLiteral = (/** @type {string} */ text) => text.replace(/[\\\][^-]/g, (char) => `\\${char}`);
  const body = chunks.map(escapeLiteral).join('-');

  if (body === '') {
    // Only empty ranges (`[z-a]`) were left: never match, or match anything when negated.
    return negated ? '.' : '(?!)';
  }

  return negated ? `[^${body}]` : `[${body}]`;
}
