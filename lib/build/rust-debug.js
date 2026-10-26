/**
 * Read back the Rust values the test-tuple recorder captured as `format!("{:?}", …)` text.
 *
 * Stage: build output consumed by the corpus stage (tuples -> adapter requests). The recorder
 * cannot serialize `css_modules::Config` or string slices of arbitrary Rust types, so it records
 * their Debug form; this module turns that text back into what the adapter expects.
 *
 * Invariant: the Debug format is the one Rust's derive prints (`Some(Config { pattern: Pattern {
 * segments: [...] }, dashed_idents: false, ... })`, string literals with `\"`, `\n`, `\u{..}`
 * escapes). Anything unrecognised is left out rather than guessed.
 */
import { pyIntOrRaise } from '../core/py-number.js';
import { pyRe } from '../core/py-re.js';
import { pyStrip, pyTruthy } from '../core/py.js';

/** @import { CssModulesConfig } from '../types.js' */

/** A Rust string literal as Debug prints it; group 1 is the escaped body. */
export const RUST_STR = String.raw`"((?:[^"\\]|\\.)*)"`;

/** Single-character escapes of Rust string literals. */
const SIMPLE_ESCAPES = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['0', '\0'],
  ['\\', '\\'],
  ['"', '"'],
  ["'", "'"],
]);

/**
 * Undo the escapes of a Rust string literal body (`\n`, `\"`, `\u{1F600}`, …). An unknown escape
 * keeps the escaped character instead of throwing: rustc rejects such a literal, so only text that
 * never compiled can hold one, and it is read leniently.
 *
 * @param {string} escaped
 * @returns {string}
 */
export function rustUnescape(escaped) {
  // Code points, so a non-BMP character after a backslash stays one character.
  const chars = Array.from(escaped);
  let out = '';
  let index = 0;

  while (index < chars.length) {
    const char = chars[index];

    if (char !== '\\') {
      out += char;
      index++;
      continue;
    }

    const next = chars[index + 1] ?? '';

    if (next === 'u' && chars[index + 2] === '{') {
      const end = chars.indexOf('}', index);

      if (end < 0) {
        // Rust's Debug output always closes `\u{…}`; anything else is not recorder output.
        throw new Error(`unterminated \\u{ escape in recorded Debug text: ${escaped}`);
      }

      out += String.fromCodePoint(pyIntOrRaise(chars.slice(index + 3, end).join(''), 16));
      index = end + 1;
      continue;
    }

    out += SIMPLE_ESCAPES.get(next) ?? next;
    index += 2;
  }

  return out;
}

/** The boolean fields of `css_modules::Config`, each read as `<field>: true|false`. */
const CSS_MODULES_FLAGS = /** @type {const} */ ([
  'dashed_idents',
  'animation',
  'grid',
  'custom_idents',
  'container',
  'pure',
]).map((key) => ({ key, pattern: pyRe(String.raw`\b${key}: (true|false)`) }));
const SEGMENTS = pyRe(String.raw`segments: \[(.*?)\]\s*\}`, 's');
const SEGMENT = pyRe(String.raw`Literal\(${RUST_STR}\)|\b(Name|Local|Hash|ContentHash)\b`, 'g');
const SEGMENT_PLACEHOLDERS = new Map([
  ['Name', '[name]'],
  ['Local', '[local]'],
  ['Hash', '[hash]'],
  ['ContentHash', '[content-hash]'],
]);
/** Lightning CSS's default pattern; the adapter applies it when `pattern` is absent. */
const DEFAULT_PATTERN = '[hash]_[local]';

/**
 * The adapter's `css_modules` object from `Some(Config { … })`, or null for `None` / nothing.
 *
 * @param {unknown} text
 * @returns {CssModulesConfig | null}
 */
export function parseCssModulesDebug(text) {
  if (!pyTruthy(text) || pyStrip(/** @type {string} */ (text)) === 'None') {
    return null;
  }

  const debug = /** @type {string} */ (text);
  /** @type {CssModulesConfig} */
  const config = {};

  for (const { key, pattern } of CSS_MODULES_FLAGS) {
    const match = pattern.exec(debug);

    if (match) {
      config[key] = match[1] === 'true';
    }
  }

  const segments = SEGMENTS.exec(debug);

  if (segments) {
    const pattern = patternFromSegments(segments[1]);

    if (pattern && pattern !== DEFAULT_PATTERN) {
      config.pattern = pattern;
    }
  }

  return config;
}

/**
 * `[Hash, Literal("_"), Local]` -> `[hash]_[local]`.
 *
 * @param {string} segments
 * @returns {string}
 */
function patternFromSegments(segments) {
  let pattern = '';

  for (const segment of segments.matchAll(SEGMENT)) {
    pattern +=
      segment[1] === undefined
        ? /** @type {string} */ (SEGMENT_PLACEHOLDERS.get(segment[2]))
        : rustUnescape(segment[1]);
  }

  return pattern;
}
