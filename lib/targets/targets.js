/**
 * Browser targets: Lightning CSS's version encoding and the Debug strings its tests print.
 *
 * Stage: shared by corpus (probe and mode targets), build (tuple mapping), mutations (retargets)
 * and report (target lists in case blocks). Lightning CSS encodes a browser version as
 * `major << 16 | minor << 8 | patch`; test helpers record `Browsers { … }`, `Targets { … }`,
 * `Features(…)` and `ParserFlags(…)` as Rust Debug text, which these parsers turn back into the
 * adapter's request fields.
 *
 * Invariant: target objects always have their keys sorted, so they serialize and compare the same
 * way whatever the input order.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { loadConfig } from '../core/paths.js';
import { pyInt } from '../core/py-number.js';
import { PY_WHITESPACE, pyStrip } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';

/** @import { Targets } from '../types.js' */

/** The `Browsers` fields of Lightning CSS. */
export const BROWSERS = Object.freeze([
  'android',
  'chrome',
  'edge',
  'firefox',
  'ie',
  'ios_saf',
  'opera',
  'safari',
  'samsung',
]);

/**
 * Unicode-aware, like Python's `\s` and `\w`, so a target string in a probe header or
 * config/modes.json parses the same way in every version.
 */
const SPACE = `[${RegExp.escape(PY_WHITESPACE)}]`;
const WORD = String.raw`[\p{L}\p{N}_]`;
const MAJOR_SHIFT = 16n;
const MINOR_SHIFT = 8n;
const BYTE = 256;
const VERSION_PARTS = 3;

/**
 * `"13.1"` -> `13 << 16 | 1 << 8`. Missing minor/patch parts are 0. The parts are OR-ed, not added,
 * so a minor part above 255 spills into the major bits; encoded targets are stored in case requests,
 * so the rule never changes. BigInt keeps the shifts unbounded (a JS `<<` wraps at 32 bits).
 *
 * @param {string} text
 * @returns {number}
 */
export function encodeVersion(text) {
  const parts = pyStrip(text)
    .split('.')
    .map((part) => versionPart(part));

  while (parts.length < VERSION_PARTS) {
    parts.push(0n);
  }

  const [major, minor, patch] = parts;

  return Number((major << MAJOR_SHIFT) | (minor << MINOR_SHIFT) | patch);
}

/**
 * Python's `int(part)` of a version part.
 *
 * @param {string} part
 * @returns {bigint}
 */
function versionPart(part) {
  const value = pyInt(part);

  if (value === null) {
    throw new LcrError(`invalid literal for int() with base 10: '${part}'`);
  }

  return BigInt(value);
}

/**
 * `852224` -> `"13.1"`: trailing zero parts are dropped.
 *
 * @param {number} value
 * @returns {string}
 */
export function decodeVersion(value) {
  // Division, not `>>`: encoded versions can reach 2^32, past JS's signed 32-bit shifts.
  const major = Math.floor(value / BYTE / BYTE);
  const minor = Math.floor(value / BYTE) % BYTE;
  const patch = value % BYTE;

  if (patch) {
    return `${major}.${minor}.${patch}`;
  }

  return minor ? `${major}.${minor}` : String(major);
}

const TARGET_ITEM = new RegExp(String.raw`^([a-z_]+)${SPACE}+(\p{Nd}+(?:\.\p{Nd}+){0,2})$`, 'u');

/**
 * `"chrome 80, safari 13.1"` -> `{ chrome: 5242880, safari: 852224 }`. `none`, `null`, `''` and
 * null give null; a preset name from config/modes.json is expanded.
 *
 * @param {string | null | undefined} spec
 * @returns {Targets | null}
 */
export function parseTargets(spec) {
  if (spec === null || spec === undefined) {
    return null;
  }

  const text = pyStrip(spec);

  if (text === '' || text === 'none' || text === 'null') {
    return null;
  }

  const presets = /** @type {import('../types.js').ModesConfig} */ (loadConfig('modes.json')).targets;

  if (Object.hasOwn(presets, text)) {
    return parseTargets(presets[text]);
  }

  /** @type {Targets} */
  const out = {};

  for (const raw of text.split(',')) {
    const item = pyStrip(raw);

    if (item) {
      const [browser, version] = parseTargetItem(item);

      out[browser] = encodeVersion(version);
    }
  }

  return sortedOrNull(out);
}

/**
 * @param {string} item `<browser> <version>`.
 * @returns {[string, string]}
 */
function parseTargetItem(item) {
  const match = TARGET_ITEM.exec(item);

  if (!match || !BROWSERS.includes(match[1])) {
    throw new LcrError(
      `bad target '${item}' (expected '<browser> <version>', browsers: ${BROWSERS.join(', ')})`,
    );
  }

  return [match[1], match[2]];
}

/**
 * `{ chrome: 5242880 }` -> `"chrome 80"`; no targets -> `"none"`.
 *
 * @param {Targets | null | undefined} targets
 * @returns {string}
 */
export function formatTargets(targets) {
  if (!targets || Object.keys(targets).length === 0) {
    return 'none';
  }

  return Object.keys(targets)
    .sort(compareCodePoints)
    .map((browser) => `${browser} ${decodeVersion(targets[browser])}`)
    .join(', ');
}

/** A `Browsers` field: `\b` before it, as a lookbehind over Python's word characters. */
const SOME_FIELD = new RegExp(String.raw`(?<!${WORD})([a-z_]+): Some\((\p{Nd}+)\)`, 'gu');

/**
 * Parse `Browsers { chrome: Some(5898240), … }`, `Some(Browsers { … })` or `None`.
 *
 * @param {string | null | undefined} text
 * @returns {Targets | null}
 */
export function parseBrowsersDebug(text) {
  if (text === null || text === undefined) {
    return null;
  }

  const trimmed = pyStrip(text);

  if (trimmed === 'None' || trimmed === '') {
    return null;
  }

  /** @type {Targets} */
  const out = {};

  // A later field of the same name wins, as with Python's dict(re.findall(...)).
  for (const [, browser, value] of trimmed.matchAll(SOME_FIELD)) {
    if (BROWSERS.includes(browser)) {
      out[browser] = /** @type {number} */ (pyInt(value));
    }
  }

  return sortedOrNull(out);
}

/**
 * @param {Targets} targets
 * @returns {Targets | null}
 */
function sortedOrNull(targets) {
  const keys = Object.keys(targets).sort(compareCodePoints);

  return keys.length === 0 ? null : Object.fromEntries(keys.map((key) => [key, targets[key]]));
}

const FEATURES_BLOCK = /pub struct Features: u32 \{([\s\S]*?)\n {2}\}/;
const FEATURE_CONST = new RegExp(String.raw`const (${WORD}+) = ([^;]+);`, 'gu');
const SHIFT_EXPRESSION = /^1 << (\p{Nd}+)$/u;
const BITS_REFERENCE = new RegExp(String.raw`Self::(${WORD}+)\.bits\(\)`, 'gu');
/** Python's universal newlines: `\r\n` and a lone `\r` read as `\n`. */
const NEWLINES = /\r\n?/g;

/**
 * The `Features` bitflags of a tree's src/targets.rs (names and values differ across revisions,
 * so each side's tuples are mapped with that side's bits). Composite flags are the OR of the
 * flags they reference.
 *
 * @param {string} srcRoot A Lightning CSS source tree.
 * @returns {Record<string, number>}
 */
export function featureBits(srcRoot) {
  const text = readFileSync(join(srcRoot, 'src', 'targets.rs'), 'utf8').replace(NEWLINES, '\n');
  const block = FEATURES_BLOCK.exec(text);

  if (!block) {
    throw new LcrError('could not find Features bitflags in src/targets.rs');
  }

  /** @type {Map<string, bigint>} */
  const bits = new Map();

  for (const [, name, rawExpression] of block[1].matchAll(FEATURE_CONST)) {
    bits.set(name, featureValue(pyStrip(rawExpression), bits));
  }

  return Object.fromEntries([...bits].map(([name, value]) => [name, Number(value)]));
}

/**
 * @param {string} expression `1 << n` or `Self::A.bits() | Self::B.bits()`.
 * @param {Map<string, bigint>} known Flags defined above this one.
 * @returns {bigint}
 */
function featureValue(expression, known) {
  const shift = SHIFT_EXPRESSION.exec(expression);

  if (shift) {
    return 1n << BigInt(/** @type {number} */ (pyInt(shift[1])));
  }

  let value = 0n;

  for (const [, reference] of expression.matchAll(BITS_REFERENCE)) {
    value |= known.get(reference) ?? 0n;
  }

  return value;
}

/** `Name(…)`; Python's `.` also matches `\r`, U+2028 and U+2029, JS's does not without `s`. */
const FLAGS_DEBUG = new RegExp(String.raw`^${SPACE}*${WORD}+\(([^\n]*)\)${SPACE}*$`, 'u');
const HEX_LITERAL = /^0x[0-9a-fA-F]+$/;

/**
 * Parse `Features(Nesting | MediaQueries)`, `Features(0x0)` or `ParserFlags(CUSTOM_MEDIA)`.
 * Without `bits`: the flag names. With `bits`: their OR, plus any hex literal parts; an unknown
 * name throws.
 *
 * @overload
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
/**
 * @overload
 * @param {string | null | undefined} text
 * @param {Record<string, number>} bits
 * @returns {number}
 */
/**
 * Implementation of the overloads above.
 *
 * @param {string | null | undefined} text
 * @param {Record<string, number>} [bits]
 * @returns {string[] | number}
 */
export function parseFlagsDebug(text, bits) {
  const match = FLAGS_DEBUG.exec(text ?? '');
  const inner = match ? pyStrip(match[1]) : '';
  const parts = inner
    .split('|')
    .map((part) => pyStrip(part))
    .filter(Boolean);
  const names = [];
  let value = 0n;

  for (const part of parts) {
    if (HEX_LITERAL.test(part)) {
      value |= BigInt(part);
      continue;
    }

    names.push(part);

    if (bits !== undefined) {
      if (!Object.hasOwn(bits, part)) {
        throw new LcrError(`unknown flag ${part}`);
      }

      value |= BigInt(bits[part]);
    }
  }

  return bits === undefined ? names : Number(value);
}

/**
 * @typedef {object} ParsedTargets
 * @property {Targets | null} targets
 * @property {number} include
 * @property {number} exclude
 */

/**
 * Parse `Targets { browsers: Some(Browsers { … }), include: Features(…), exclude: Features(…) }`.
 *
 * @param {string | null | undefined} text
 * @param {Record<string, number>} bits
 * @returns {ParsedTargets}
 */
export function parseTargetsDebug(text, bits) {
  if (text === null || text === undefined) {
    return { targets: null, include: 0, exclude: 0 };
  }

  const include = /include: (Features\([^)]*\))/.exec(text);
  const exclude = /exclude: (Features\([^)]*\))/.exec(text);

  return {
    targets: parseBrowsersDebug(text),
    include: include ? parseFlagsDebug(include[1], bits) : 0,
    exclude: exclude ? parseFlagsDebug(exclude[1], bits) : 0,
  };
}
