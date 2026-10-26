/**
 * JSON exactly as Python's `json` module reads and writes it.
 *
 * Stage: shared by every stage that reads or writes a stage file, and by the case-id hash.
 * py-final wrote every `.json`/`.jsonl` file with `json.dumps` and hashed case ids from
 * `json.dumps(parts, sort_keys=True, ensure_ascii=False)`. Existing runs, baselines and analyses
 * must stay valid and the differential checks diff files byte for byte, so this module reproduces
 * that output exactly: `", "` / `": "` separators (or `","` plus newlines with `indent`), keys
 * sorted by code point, non-ASCII kept (or `\uXXXX` with `ensureAscii`), Python's float repr and
 * `NaN` / `Infinity` literals.
 *
 * Ints and floats. Python keeps them apart (`1` and `1.0`); JavaScript has one number type. The
 * rule, applied on both read and write:
 * - A plain JS number that is an integer below 1e16 in magnitude is a Python int and prints as
 *   digits. Every other plain number (fractions, `NaN`, `±Infinity`, magnitudes from 1e16 up)
 *   prints with Python's float repr. Python prints a float that large in exponent form too, so
 *   the only numbers this cannot tell apart are integral floats below 1e16.
 * - Those are boxed in a `PyFloat` (`pyFloat(1)` prints `1.0`). `loads` boxes every integral
 *   number written as a float literal (`1.0`, `3e2`), so reading a file and writing it back is
 *   byte-identical. Code that computes a Python float (a ratio, `round(x, 3)`, a probe timeout)
 *   wraps the result with `pyFloat()`, which boxes only when boxing is needed.
 * - Integer literals beyond 2^53 are read as `BigInt` so their digits survive a round trip.
 *
 * A `PyFloat` is an object: compare it with `Number(x)` (or `<`/`>`), never with `===`, and test it
 * with `pyTruthy` rather than JS truthiness. Hash inputs never contain floats (they are tuple
 * fields recorded from Rust integers, strings and booleans), so case ids are unaffected.
 */

/** Integers at or above this magnitude print in exponent form in Python's float repr. */
const PY_INT_PRINT_LIMIT = 1e16;

/** Python's repr switches to exponent notation outside 1e-4 <= |x| < 1e16 (decimal point position). */
const REPR_MIN_DECIMAL_POINT = -4;
const REPR_MAX_DECIMAL_POINT = 16;

/** A float whose value is an integer, kept apart from ints so it prints as `1.0`. */
export class PyFloat {
  /** @param {number} value */
  constructor(value) {
    /** @readonly */
    this.value = value;
    Object.freeze(this);
  }

  /** @returns {number} */
  valueOf() {
    return this.value;
  }

  /**
   * Template literals get Python's `str(float)`; arithmetic and comparisons get the number.
   *
   * @param {string} hint
   * @returns {number | string}
   */
  [Symbol.toPrimitive](hint) {
    return hint === 'string' ? pyFloatRepr(this.value) : this.value;
  }

  /** @returns {string} */
  toString() {
    return pyFloatRepr(this.value);
  }
}

/** @typedef {number | PyFloat} PyNumber A number read from or written to a Python-compatible file. */

/**
 * Mark a number as a Python float. Returns a `PyFloat` only when the plain number would otherwise
 * print as an int; fractions, `NaN` and `Infinity` stay plain numbers.
 *
 * @param {number | PyFloat} value
 * @returns {PyNumber}
 */
export function pyFloat(value) {
  const number = Number(value);

  return isIntLike(number) ? new PyFloat(number) : number;
}

/**
 * True for a boxed integral float.
 *
 * @param {unknown} value
 * @returns {value is PyFloat}
 */
export function isPyFloat(value) {
  return value instanceof PyFloat;
}

/**
 * True when a plain number prints as a Python int.
 *
 * @param {number} value
 * @returns {boolean}
 */
function isIntLike(value) {
  return Number.isInteger(value) && Math.abs(value) < PY_INT_PRINT_LIMIT;
}

/**
 * Python's `repr(float)`: the shortest round-tripping digits, fixed notation for
 * 1e-4 <= |x| < 1e16 (with `.0` when integral), otherwise `d.ddde±XX` with at least two exponent
 * digits. `nan`, `inf` and `-inf` as Python spells them (JSON uses `NaN`/`Infinity` instead).
 *
 * @param {number} value
 * @returns {string}
 */
export function pyFloatRepr(value) {
  if (Number.isNaN(value)) {
    return 'nan';
  }

  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : '-inf';
  }

  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  // toExponential() without an argument yields the shortest digits that round-trip, which are the
  // digits Python's repr uses (both pick the shortest, closest representation).
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const decimalPoint = Number(exponentText) + 1;

  if (decimalPoint <= REPR_MIN_DECIMAL_POINT || decimalPoint > REPR_MAX_DECIMAL_POINT) {
    return sign + exponentForm(digits, decimalPoint - 1);
  }

  return sign + fixedForm(digits, decimalPoint);
}

/**
 * @param {string} digits Significant digits without a decimal point.
 * @param {number} exponent Decimal exponent of the first digit.
 * @returns {string}
 */
function exponentForm(digits, exponent) {
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const exponentSign = exponent < 0 ? '-' : '+';

  return `${mantissa}e${exponentSign}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

/**
 * @param {string} digits Significant digits without a decimal point.
 * @param {number} decimalPoint How many digits stand before the decimal point (may be <= 0).
 * @returns {string}
 */
function fixedForm(digits, decimalPoint) {
  if (decimalPoint <= 0) {
    return `0.${'0'.repeat(-decimalPoint)}${digits}`;
  }

  if (decimalPoint >= digits.length) {
    return `${digits}${'0'.repeat(decimalPoint - digits.length)}.0`;
  }

  return `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
}

// ---------------------------------------------------------------------------------------------
// Writing

/**
 * @typedef {object} DumpOptions
 * @property {number} [indent] Spaces per level; switches to Python's multi-line layout.
 * @property {boolean} [sortKeys] Sort object keys by code point (`sort_keys=True`).
 * @property {boolean} [ensureAscii] Escape non-ASCII as `\uXXXX` (Python's default is true; the
 *   harness always passes false for files and hashes, true only where py-final called plain
 *   `json.dumps`).
 */

/**
 * Python's `json.dumps(value, indent=…, sort_keys=…, ensure_ascii=…)`.
 *
 * Object members whose value is `undefined` are skipped (a missing key, as in `JSON.stringify`).
 * `Map`, `Set`, class instances other than `PyFloat`, functions and symbols are rejected, as
 * Python rejects types it cannot serialize.
 *
 * @param {unknown} value
 * @param {DumpOptions} [options]
 * @returns {string}
 */
export function dumps(value, { indent, sortKeys = false, ensureAscii = true } = {}) {
  const encoder = new Encoder({ indent, sortKeys, ensureAscii });

  return encoder.encode(value, 0);
}

/**
 * A stage `.json` file: `json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function jsonFileText(value) {
  return `${dumps(value, { indent: 2, sortKeys: true, ensureAscii: false })}\n`;
}

/**
 * One `.jsonl` row (no newline) and the case-id hash input:
 * `json.dumps(value, sort_keys=True, ensure_ascii=False)`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function jsonLineText(value) {
  return dumps(value, { sortKeys: true, ensureAscii: false });
}

const NON_ASCII = /[\u007f-\uffff]/g;

class Encoder {
  /** @param {{ indent: number | undefined, sortKeys: boolean, ensureAscii: boolean }} options */
  constructor({ indent, sortKeys, ensureAscii }) {
    this.indent = indent === undefined ? null : ' '.repeat(indent);
    this.sortKeys = sortKeys;
    this.ensureAscii = ensureAscii;
    // Python uses "," before a newline when indenting, ", " on one line.
    this.itemSeparator = this.indent === null ? ', ' : ',';
  }

  /**
   * @param {unknown} value
   * @param {number} depth
   * @returns {string}
   */
  encode(value, depth) {
    if (value === null) {
      return 'null';
    }

    switch (typeof value) {
      case 'string':
        return this.encodeString(value);
      case 'boolean':
        return value ? 'true' : 'false';
      case 'number':
        return encodeNumber(value);
      case 'bigint':
        return value.toString();
      case 'object':
        return this.encodeObject(value, depth);
      default:
        throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
    }
  }

  /**
   * @param {object} value
   * @param {number} depth
   * @returns {string}
   */
  encodeObject(value, depth) {
    if (value instanceof PyFloat) {
      return encodeFloat(value.value);
    }

    if (Array.isArray(value)) {
      return this.encodeArray(value, depth);
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Object of type ${value.constructor?.name} is not JSON serializable`);
    }

    return this.encodeRecord(/** @type {Record<string, unknown>} */ (value), depth);
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  encodeString(value) {
    // JSON.stringify escapes exactly what Python escapes with ensure_ascii=False: quote, backslash
    // and C0 controls, with the same short forms and lowercase \u00XX.
    const text = JSON.stringify(value);

    if (!this.ensureAscii) {
      return text;
    }

    // ensure_ascii also escapes DEL and everything above it, one UTF-16 unit at a time (so astral
    // characters become surrogate-pair escapes, as in Python).
    return text.replace(NON_ASCII, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }

  /**
   * @param {unknown[]} items
   * @param {number} depth
   * @returns {string}
   */
  encodeArray(items, depth) {
    if (items.length === 0) {
      return '[]';
    }

    const parts = items.map((item, index) => {
      if (item === undefined) {
        throw new TypeError(`array item ${index} is undefined`);
      }

      return this.encode(item, depth + 1);
    });

    return this.wrap('[', parts, ']', depth);
  }

  /**
   * @param {Record<string, unknown>} record
   * @param {number} depth
   * @returns {string}
   */
  encodeRecord(record, depth) {
    const keys = Object.keys(record).filter((key) => record[key] !== undefined);

    if (keys.length === 0) {
      return '{}';
    }

    if (this.sortKeys) {
      keys.sort(compareCodePoints);
    }

    const parts = keys.map((key) => `${this.encodeString(key)}: ${this.encode(record[key], depth + 1)}`);

    return this.wrap('{', parts, '}', depth);
  }

  /**
   * @param {string} open
   * @param {string[]} parts
   * @param {string} close
   * @param {number} depth
   * @returns {string}
   */
  wrap(open, parts, close, depth) {
    if (this.indent === null) {
      return open + parts.join(this.itemSeparator) + close;
    }

    const inner = `\n${this.indent.repeat(depth + 1)}`;
    const outer = `\n${this.indent.repeat(depth)}`;

    return open + inner + parts.join(this.itemSeparator + inner) + outer + close;
  }
}

/**
 * @param {number} value
 * @returns {string}
 */
function encodeNumber(value) {
  if (isIntLike(value)) {
    // String(-0) is "0", matching Python's int 0.
    return String(value);
  }

  return encodeFloat(value);
}

/**
 * Python's float encoder: repr, with JavaScript-style names for the non-finite values.
 *
 * @param {number} value
 * @returns {string}
 */
function encodeFloat(value) {
  if (Number.isNaN(value)) {
    return 'NaN';
  }

  if (!Number.isFinite(value)) {
    return value > 0 ? 'Infinity' : '-Infinity';
  }

  return pyFloatRepr(value);
}

/**
 * Compare strings by Unicode code point, as Python's `sorted()` and `sort_keys` do. JavaScript's
 * default compares UTF-16 units, which orders astral characters before U+E000–U+FFFF.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareCodePoints(left, right) {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index++) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);

    if (a !== b) {
      return codePointRank(a) - codePointRank(b);
    }
  }

  return left.length - right.length;
}

const SURROGATE_FIRST = 0xd800;
const PRIVATE_USE_FIRST = 0xe000;
// Moves surrogates (astral characters) above every BMP unit, preserving code point order.
const SURROGATE_SHIFT = 0x2000;
const BMP_HIGH_SHIFT = 0x800;

/**
 * @param {number} unit A UTF-16 code unit.
 * @returns {number}
 */
function codePointRank(unit) {
  if (unit < SURROGATE_FIRST) {
    return unit;
  }

  return unit < PRIVATE_USE_FIRST ? unit + SURROGATE_SHIFT : unit - BMP_HIGH_SHIFT;
}

// ---------------------------------------------------------------------------------------------
// Reading

const FLOAT_LITERAL = /[.eE]/;

/**
 * JSON.parse reviver that keeps Python's int/float distinction (see the module header).
 *
 * @param {string} _key
 * @param {unknown} value
 * @param {{ source?: string }} [context]
 * @returns {unknown}
 */
function keepNumberKinds(_key, value, context) {
  if (typeof value !== 'number' || context?.source === undefined) {
    return value;
  }

  const source = context.source;

  if (FLOAT_LITERAL.test(source)) {
    return Number.isInteger(value) && Math.abs(value) < PY_INT_PRINT_LIMIT ? new PyFloat(value) : value;
  }

  return Number.isSafeInteger(value) ? value : BigInt(source);
}

/**
 * Python's `json.loads`: standard JSON plus the `NaN`, `Infinity` and `-Infinity` literals Python
 * writes for non-finite floats. Integral float literals come back as `PyFloat`, integers beyond
 * 2^53 as `BigInt`.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function loads(text) {
  try {
    return JSON.parse(text, /** @type {(key: string, value: unknown) => unknown} */ (keepNumberKinds));
  } catch (error) {
    if (error instanceof SyntaxError && NON_FINITE_LITERAL.test(text)) {
      return new LenientParser(text).parseDocument();
    }

    throw error;
  }
}

const NON_FINITE_LITERAL = /NaN|Infinity/;

/**
 * A small JSON parser for the rare file that holds `NaN` or `Infinity` (perf.json when a timing
 * failed). Same results as `loads` otherwise; speed does not matter here.
 */
class LenientParser {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.position = 0;
  }

  /** @returns {unknown} */
  parseDocument() {
    const value = this.parseValue();

    this.skipWhitespace();

    if (this.position !== this.text.length) {
      this.fail('extra data');
    }

    return value;
  }

  /** @returns {unknown} */
  parseValue() {
    this.skipWhitespace();

    const char = this.text[this.position];

    if (char === '{') {
      return this.parseObject();
    }

    if (char === '[') {
      return this.parseArray();
    }

    if (char === '"') {
      return this.parseString();
    }

    return this.parseLiteral();
  }

  /** @returns {Record<string, unknown>} */
  parseObject() {
    /** @type {Record<string, unknown>} */
    const record = {};

    this.position++;
    this.skipWhitespace();

    if (this.text[this.position] === '}') {
      this.position++;

      return record;
    }

    for (;;) {
      this.skipWhitespace();

      const key = this.parseString();

      this.expect(':');
      Object.defineProperty(record, key, {
        value: this.parseValue(),
        enumerable: true,
        writable: true,
        configurable: true,
      });

      if (this.endOf('}')) {
        return record;
      }
    }
  }

  /** @returns {unknown[]} */
  parseArray() {
    /** @type {unknown[]} */
    const items = [];

    this.position++;
    this.skipWhitespace();

    if (this.text[this.position] === ']') {
      this.position++;

      return items;
    }

    for (;;) {
      items.push(this.parseValue());

      if (this.endOf(']')) {
        return items;
      }
    }
  }

  /** @returns {string} */
  parseString() {
    // JSON strings cannot hold raw control characters.
    // eslint-disable-next-line no-control-regex -- the class excludes them on purpose
    const match = /^"(?:[^"\\\u0000-\u001f]|\\.)*"/su.exec(this.text.slice(this.position));

    if (!match) {
      this.fail('bad string');
    }

    this.position += match[0].length;

    return JSON.parse(match[0]);
  }

  /** @returns {unknown} */
  parseLiteral() {
    const rest = this.text.slice(this.position);
    const match = /^(?:-?Infinity|NaN|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(
      rest,
    );

    if (!match) {
      this.fail('expecting value');
    }

    this.position += match[0].length;

    return literalValue(match[0]);
  }

  /**
   * After a member: consume `,` (more follow, returns false) or the closing bracket (returns true).
   *
   * @param {string} close
   * @returns {boolean}
   */
  endOf(close) {
    this.skipWhitespace();

    const char = this.text[this.position++];

    if (char === close) {
      return true;
    }

    if (char !== ',') {
      this.fail(`expecting ',' or '${close}'`);
    }

    return false;
  }

  /** @param {string} char */
  expect(char) {
    this.skipWhitespace();

    if (this.text[this.position++] !== char) {
      this.fail(`expecting '${char}'`);
    }
  }

  skipWhitespace() {
    while (/[ \t\n\r]/.test(this.text[this.position] ?? '')) {
      this.position++;
    }
  }

  /**
   * @param {string} reason
   * @returns {never}
   */
  fail(reason) {
    throw new SyntaxError(`JSON: ${reason} at position ${this.position}`);
  }
}

/**
 * @param {string} literal
 * @returns {unknown}
 */
function literalValue(literal) {
  const keywords = /** @type {Record<string, unknown>} */ ({
    true: true,
    false: false,
    null: null,
    NaN: Number.NaN,
    Infinity: Number.POSITIVE_INFINITY,
    '-Infinity': Number.NEGATIVE_INFINITY,
  });

  if (Object.hasOwn(keywords, literal)) {
    return keywords[literal];
  }

  return keepNumberKinds('', Number(literal), { source: literal });
}
