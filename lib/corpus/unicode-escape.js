/**
 * Python's `unicode_escape` codec, which py-final decoded probe assertions with.
 *
 * Stage: corpus (probe assertions `output-contains:"…"` and friends, judged in assess.js).
 *
 * Invariant: the decoded text equals CPython 3.14's `text.encode().decode("unicode_escape")`, since
 * it decides whether an assertion holds, and those results are diffed against py-final.
 */

/** Single-character escapes of Python's `unicode_escape` codec. */
const SIMPLE_ESCAPES = new Map([
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['a', '\x07'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
]);

/** Hex digits each `\x`, `\u` and `\U` escape takes. */
const HEX_ESCAPE_WIDTH = new Map([
  ['x', 2],
  ['u', 4],
  ['U', 8],
]);

const MAX_OCTAL_DIGITS = 3;
const MAX_CODE_POINT = 0x10ffff;
const BACKSLASH = 0x5c;
const LINE_FEED = 0x0a;

/**
 * `text.encode().decode("unicode_escape")`, the decoding py-final applies to an `output-*:"…"`
 * assertion that contains a backslash. The codec reads the UTF-8 bytes as Latin-1, so non-ASCII
 * characters come out as mojibake (`é` becomes `Ã©`); that is what py-final compared with, so it
 * is kept. Throws RangeError where Python raises UnicodeDecodeError (a trailing backslash, a
 * truncated or out-of-range escape) and for `\N{name}`, which needs the Unicode name database.
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeUnicodeEscape(text) {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  let index = 0;

  while (index < bytes.length) {
    if (bytes[index] !== BACKSLASH) {
      out += String.fromCharCode(bytes[index]);
      index++;
      continue;
    }

    const [decoded, next] = decodeEscape(bytes, index + 1);

    out += decoded;
    index = next;
  }

  return out;
}

/**
 * One escape whose backslash precedes `start`.
 *
 * @param {Buffer} bytes
 * @param {number} start
 * @returns {[string, number]} The decoded text and the index after the escape.
 */
function decodeEscape(bytes, start) {
  if (start >= bytes.length) {
    throw new RangeError("'unicodeescape' codec can't decode byte 0x5c: \\ at end of string");
  }

  const char = String.fromCharCode(bytes[start]);
  const simple = SIMPLE_ESCAPES.get(char);

  if (simple !== undefined) {
    return [simple, start + 1];
  }

  if (bytes[start] === LINE_FEED) {
    return ['', start + 1];
  }

  if (char >= '0' && char <= '7') {
    return decodeOctal(bytes, start);
  }

  const width = HEX_ESCAPE_WIDTH.get(char);

  if (width !== undefined) {
    return decodeHex(bytes, start + 1, width, char);
  }

  if (char === 'N') {
    throw new RangeError('\\N{...} escapes in probe assertions are not supported');
  }

  // Unknown escapes keep the backslash (Python only warns).
  return [`\\${char}`, start + 1];
}

/**
 * @param {Buffer} bytes
 * @param {number} start
 * @returns {[string, number]}
 */
function decodeOctal(bytes, start) {
  let end = start;

  while (end < bytes.length && end - start < MAX_OCTAL_DIGITS && bytes[end] >= 0x30 && bytes[end] <= 0x37) {
    end++;
  }

  const value = Number.parseInt(bytes.subarray(start, end).toString('latin1'), 8);

  return [String.fromCodePoint(value), end];
}

/**
 * @param {Buffer} bytes
 * @param {number} start First hex digit.
 * @param {number} width
 * @param {string} kind `x`, `u` or `U`.
 * @returns {[string, number]}
 */
function decodeHex(bytes, start, width, kind) {
  const digits = bytes.subarray(start, start + width).toString('latin1');

  if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
    throw new RangeError(`'unicodeescape' codec can't decode: truncated \\${kind} escape`);
  }

  const value = Number.parseInt(digits, 16);

  if (value > MAX_CODE_POINT) {
    throw new RangeError("'unicodeescape' codec can't decode: illegal Unicode character");
  }

  return [String.fromCodePoint(value), start + width];
}
