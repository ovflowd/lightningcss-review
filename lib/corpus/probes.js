/**
 * The lcr-probe v1 format: parse, validate and load probe files (references/probe-format.md,
 * templates/probe.css.tmpl).
 *
 * Stage: corpus (curated probes from corpus/probes and PR probes from <run>/probes become cases)
 * and `lcr validate-probes`.
 *
 * Reads: `*.css` files below the probe directories, config/areas.json, config/modes.json (target
 * presets). Writes nothing; `validateCli` prints its report on stdout.
 *
 * A probe is a CSS file whose first thing is a `/*! lcr-probe … *\/` header of `key: value` lines.
 * A probe with any error is left out of the corpus (and reported as a problem); warnings never
 * exclude a probe.
 *
 * Invariants:
 * - Probes load in `Path.rglob` order and are returned sorted by id; the first file with a given id
 *   wins. Problem lines carry the file path as pathlib joins it, so `lcr validate-probes` prints
 *   the same lines from one version to the next.
 * - Header values are matched with Python's regex semantics (Unicode `\s`, `\w`, `\d`), so the set
 *   of valid probes, and with it the corpus and its case ids, does not change between versions.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { readPyText } from '../core/files.js';
import { print } from '../core/log.js';
import { joinPath, purePath, rglobSorted } from '../core/pathlib.js';
import { SKILL_DIR, loadConfig } from '../core/paths.js';
import { pyDigitsToInt, pyParseFloat } from '../core/py-number.js';
import { PY_DIGIT, PY_SPACE, PY_WORD, PY_WORD_END, PY_WORD_START } from '../core/py-re.js';
import { compareCodePoints, pySlice, pySorted, pySplit, pySplitlines, pyStrip } from '../core/py.js';
import { pyFloat } from '../core/pyjson.js';
import { parseTargets } from '../targets/targets.js';

/** @import { AdapterRequest, AreasConfig, Targets } from '../types.js' */
/** @import { PyFloat } from '../core/pyjson.js' */

/** Probe modes and what they mean for the request: see `Probe.request`. */
export const MODES = Object.freeze(['print', 'minify', 'lower', 'lower-minify']);

/**
 * Flags that are request options rather than parser flags. Any other kebab-case flag is passed
 * through as a `ParserFlags` name (a draft flag a PR adds: `custom-functions` ->
 * `ParserFlags::CUSTOM_FUNCTIONS`); a revision without it answers with a request error.
 */
export const NON_PARSER_FLAGS = Object.freeze(['error-recovery', 'css-modules']);

/** Every header key the format defines; others draw a warning. */
export const KEYS = Object.freeze([
  'id',
  'area',
  'title',
  'mode',
  'targets',
  'flags',
  'expect',
  'known',
  'ref',
  'repro',
  'timeout',
  'dom',
  'note',
]);

/** Header keys a probe must have, non-empty. */
const REQUIRED_KEYS = Object.freeze(['id', 'area', 'title', 'mode', 'expect', 'known', 'ref']);

/** Largest per-probe adapter timeout, in seconds. */
export const MAX_TIMEOUT = 600;

/** Problem and warning texts quote at most this many characters of the offending value. */
const QUOTE_CHARS = 80;

const UNUSED_SYMBOLS = 'unused-symbols:';
const ELLIPSIS = String.fromCodePoint(0x2026);

const HEADER_RE = new RegExp(`^${PY_SPACE}*/\\*!${PY_SPACE}*lcr-probe${PY_WORD_END}(.*?)\\*/`, 'su');
const HEADER_LINE_RE = new RegExp(`^${PY_SPACE}*([a-z-]+):${PY_SPACE}?(.*)$`, 'su');
const FLAG_RE = /^(?:error-recovery|css-modules|unused-symbols:[\p{L}\p{N}_|-]+|[a-z][a-z0-9-]*)$/u;
const EXPECT_RE =
  /^(?:equivalent|idempotent|no-panic|parse-error|output-(?:contains|not-contains|equals):"(?:.*)")$/su;
const KNOWN_RE = new RegExp(
  `^(?:none|open-issue#${PY_DIGIT}+|open-bug|fixed-by#(?:${PY_DIGIT}+|[0-9a-f]{7,40}))$`,
  'u',
);
const REPRO_RE = new RegExp(`^#(${PY_DIGIT}+)$`, 'u');
const ID_RE = /^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/;
const REF_RE = new RegExp(`^https?://[^${PY_SPACE.slice(1, -1)}<>{}"'\`\\\\]+$`, 'u');
// A ref must be a real URL, not a template leftover: `...`, `…`, TODO-style words, `NNN`, or a
// `/pull/<word>` path where the number should be.
const REF_PLACEHOLDER_RE = new RegExp(
  `\\.\\.\\.|${ELLIPSIS}|${PY_WORD_START}(?:TODO|TBD|XXX|NNNN?)(?!${PY_WORD})|/(?:pull|issues)/[A-Za-z]+(?:$|[/#?])`,
  'u',
);

/** One parsed probe file, valid or not (`errors` lists why not). */
export class Probe {
  /** @param {ProbeFields} fields */
  constructor(fields) {
    /** @type {string} The file, as pathlib prints it. */
    this.path = fields.path;
    /** @type {string} `<area>/<slug>`. */
    this.id = fields.id;
    /** @type {string} */
    this.area = fields.area;
    /** @type {string} */
    this.title = fields.title;
    /** @type {string} */
    this.mode = fields.mode;
    /** @type {Targets | null} */
    this.targets = fields.targets;
    /** @type {string} The header's targets text (`none` when absent). */
    this.targetsText = fields.targetsText;
    /** @type {string[]} */
    this.flags = fields.flags;
    /** @type {string[]} */
    this.expect = fields.expect;
    /** @type {string} */
    this.known = fields.known;
    /** @type {string[]} */
    this.refs = fields.refs;
    /** @type {string} The CSS body, without surrounding blank lines, ending in one newline. */
    this.css = fields.css;
    /** @type {string | null} */
    this.dom = fields.dom;
    /** @type {string | null} */
    this.note = fields.note;
    /** @type {number | bigint | null} Issue number this probe reproduces. */
    this.repro = fields.repro;
    /** @type {PyFloat | number | null} Adapter timeout in seconds (a Python float). */
    this.timeout = fields.timeout;
    /** @type {string} `curated`, `pr` or `cli`. */
    this.origin = fields.origin;
    /** @type {string[]} */
    this.errors = fields.errors;
    /** @type {string[]} */
    this.warnings = fields.warnings;
  }

  /**
   * The adapter request for this probe (without an id). `lower` without targets is a pretty
   * printed minify, so targets are sent whenever they are set or the mode lowers.
   *
   * @returns {AdapterRequest}
   */
  request() {
    /** @type {AdapterRequest} */
    const request = {
      kind: 'sheet',
      css: this.css,
      minify: this.mode !== 'print',
      compact: this.mode === 'minify' || this.mode === 'lower-minify',
      targets: this.mode.startsWith('lower') || this.targets ? this.targets : null,
    };
    const parserFlags = this.flags.filter(
      (flag) => !NON_PARSER_FLAGS.includes(flag) && !flag.startsWith(UNUSED_SYMBOLS),
    );

    if (parserFlags.length) {
      request.flags = parserFlags;
    }

    if (this.flags.includes('error-recovery')) {
      request.error_recovery = true;
    }

    if (this.flags.includes('css-modules')) {
      request.css_modules = {};
      request.filename = 'test.css';
    }

    for (const flag of this.flags) {
      if (flag.startsWith(UNUSED_SYMBOLS)) {
        request.unused_symbols = flag.slice(UNUSED_SYMBOLS.length).split('|').sort(compareCodePoints);
      }
    }

    return request;
  }
}

/**
 * @typedef {object} ProbeFields
 * @property {string} path
 * @property {string} id
 * @property {string} area
 * @property {string} title
 * @property {string} mode
 * @property {Targets | null} targets
 * @property {string} targetsText
 * @property {string[]} flags
 * @property {string[]} expect
 * @property {string} known
 * @property {string[]} refs
 * @property {string} css
 * @property {string | null} dom
 * @property {string | null} note
 * @property {number | bigint | null} repro
 * @property {PyFloat | number | null} timeout
 * @property {string} origin
 * @property {string[]} errors
 * @property {string[]} warnings
 */

/**
 * A comma-separated header list in which double-quoted strings may contain commas.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function splitList(value) {
  /** @type {string[]} */
  const items = [];
  let current = '';
  let quoted = false;

  for (const char of value) {
    if (char === '"') {
      quoted = !quoted;
    }

    if (char === ',' && !quoted) {
      pushStripped(items, current);
      current = '';
    } else {
      current += char;
    }
  }

  pushStripped(items, current);

  return items;
}

/**
 * @param {string[]} items
 * @param {string} item
 * @returns {void}
 */
function pushStripped(items, item) {
  const stripped = pyStrip(item);

  if (stripped) {
    items.push(stripped);
  }
}

/**
 * `Path.stem` (Python 3.14): the name without its last suffix, unless what is left is only dots.
 *
 * @param {string} path
 * @returns {string}
 */
function pathStem(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');

  if (dot !== -1 && name.slice(0, dot).replace(/^\.+/, '')) {
    return name.slice(0, dot);
  }

  return name;
}

/**
 * Parse one probe file. A file without a header is not a probe at all (LcrError); every other
 * defect is collected in `errors` (excluding the probe) or `warnings`.
 *
 * @param {string} path
 * @param {string} [origin]
 * @returns {Probe}
 */
export function parseProbe(path, origin = 'curated') {
  const text = readPyText(path);
  const match = HEADER_RE.exec(text);

  if (!match) {
    throw new LcrError(`${path}: missing /*! lcr-probe ... */ header`);
  }

  const css = text.slice(match[0].length);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const fields = parseHeader(match[1], errors, warnings);
  const value = (/** @type {string} */ key) => fields.get(key) ?? '';

  for (const key of REQUIRED_KEYS) {
    if (!value(key)) {
      errors.push(`missing required key ${key}`);
    }
  }

  const { targets, targetsText } = checkModeAndTargets(fields, errors);
  const flags = checkedList(value('flags'), FLAG_RE, 'unknown flag', errors);
  const expect = checkedList(value('expect'), EXPECT_RE, 'bad expect', errors);

  checkKnownAndId(fields, path, errors, warnings);

  const refs = checkRefs(value('ref'), errors);
  const repro = checkRepro(value('repro'), errors);
  const timeout = checkTimeout(value('timeout'), errors);

  if (!pyStrip(css)) {
    errors.push('empty CSS body');
  }

  return new Probe({
    path,
    id: value('id'),
    area: value('area'),
    title: value('title'),
    mode: value('mode'),
    targets,
    targetsText,
    flags,
    expect,
    known: value('known'),
    refs,
    css: `${pyStrip(css, '\n')}\n`,
    dom: value('dom') || null,
    note: value('note') || null,
    repro,
    timeout,
    origin,
    errors,
    warnings,
  });
}

/**
 * The header's `key: value` lines. A repeated key is an error and the last value wins.
 *
 * @param {string} header
 * @param {string[]} errors
 * @param {string[]} warnings
 * @returns {Map<string, string>}
 */
function parseHeader(header, errors, warnings) {
  /** @type {Map<string, string>} */
  const fields = new Map();

  for (const line of pySplitlines(header)) {
    if (!pyStrip(line)) {
      continue;
    }

    const match = HEADER_LINE_RE.exec(line);

    if (!match) {
      errors.push(`bad header line: ${pySlice(pyStrip(line), 0, QUOTE_CHARS)}`);
      continue;
    }

    const [, key, rawValue] = match;

    if (fields.has(key)) {
      errors.push(`duplicate key ${key}`);
    }

    if (!KEYS.includes(key)) {
      warnings.push(`unknown header key ${key}`);
    }

    fields.set(key, pyStrip(rawValue));
  }

  return fields;
}

/**
 * Validate `area`, `mode` and `targets`; parse the targets.
 *
 * @param {Map<string, string>} fields
 * @param {string[]} errors
 * @returns {{ targets: Targets | null, targetsText: string }}
 */
function checkModeAndTargets(fields, errors) {
  const areas = /** @type {AreasConfig} */ (loadConfig('areas.json')).areas;
  const area = fields.get('area') ?? '';
  const mode = fields.get('mode') ?? '';

  if (area && !Object.hasOwn(areas, area)) {
    errors.push(`unknown area ${area}`);
  }

  if (mode && !MODES.includes(mode)) {
    errors.push(`unknown mode ${mode}`);
  }

  const targetsText = fields.get('targets') ?? 'none';
  let targets = null;

  try {
    targets = parseTargets(targetsText);
  } catch (error) {
    if (!(error instanceof LcrError)) {
      throw error;
    }

    errors.push(error.message);
  }

  if (mode === 'lower-minify' && !targets) {
    errors.push('lower-minify needs targets (without targets it is `minify`)');
  }

  return { targets, targetsText };
}

/**
 * Split a list field and report every item the pattern rejects as `<label> <item>`.
 *
 * @param {string} value
 * @param {RegExp} pattern
 * @param {string} label
 * @param {string[]} errors
 * @returns {string[]}
 */
function checkedList(value, pattern, label, errors) {
  const items = splitList(value);

  for (const item of items) {
    if (!pattern.test(item)) {
      errors.push(`${label} ${item}`);
    }
  }

  return items;
}

/**
 * `known` must be one of the documented states; the id must be `<area>/<slug>` and the slug
 * should be the file name.
 *
 * @param {Map<string, string>} fields
 * @param {string} path
 * @param {string[]} errors
 * @param {string[]} warnings
 * @returns {void}
 */
function checkKnownAndId(fields, path, errors, warnings) {
  const known = fields.get('known') ?? '';
  const id = fields.get('id') ?? '';

  if (known && !KNOWN_RE.test(known)) {
    errors.push(`bad known ${known}`);
  }

  if (!id) {
    return;
  }

  if (!ID_RE.test(id)) {
    errors.push(`bad id ${id} (expected <area>/<kebab-slug>)`);

    return;
  }

  const slug = id.slice(id.indexOf('/') + 1);

  if (slug !== pathStem(path)) {
    warnings.push(`file name ${basename(path)} does not match the id slug ${slug}`);
  }
}

/**
 * The whitespace-separated `ref` URLs; each must be a full URL without template placeholders.
 *
 * @param {string} value
 * @param {string[]} errors
 * @returns {string[]}
 */
function checkRefs(value, errors) {
  const refs = pySplit(value);

  for (const ref of refs) {
    if (!REF_RE.test(ref) || REF_PLACEHOLDER_RE.test(ref)) {
      errors.push(`bad ref ${pySlice(ref, 0, QUOTE_CHARS)} (a full URL without placeholders)`);
    }
  }

  return refs;
}

/**
 * `repro: #<issue>`: the probe reproduces that issue.
 *
 * @param {string} value
 * @param {string[]} errors
 * @returns {number | bigint | null}
 */
function checkRepro(value, errors) {
  if (!value) {
    return null;
  }

  const match = REPRO_RE.exec(value);

  if (!match) {
    errors.push(`bad repro ${value} (expected #<issue number>)`);

    return null;
  }

  return pyDigitsToInt(match[1]);
}

/**
 * `timeout: <seconds>` for probes that are slow by design; kept as a Python float.
 *
 * @param {string} value
 * @param {string[]} errors
 * @returns {PyFloat | number | null}
 */
function checkTimeout(value, errors) {
  if (!value) {
    return null;
  }

  // Unparseable text counts as out of range, so it gets the same error as a negative timeout.
  const seconds = pyParseFloat(value) ?? -1;

  if (!(seconds > 0 && seconds <= MAX_TIMEOUT)) {
    errors.push(`bad timeout ${value} (seconds, 0 < t <= ${MAX_TIMEOUT})`);

    return null;
  }

  return pyFloat(seconds);
}

/**
 * @typedef {[directory: string, origin: string]} ProbeDir A probe directory and the origin its
 *   probes get (`curated`, `pr`, `cli`).
 */

/**
 * Load every valid probe below the given directories. Invalid files, files without a header and
 * duplicate ids become problem lines instead.
 *
 * @param {readonly ProbeDir[]} dirs
 * @returns {{ probes: Probe[], problems: string[] }}
 */
export function loadProbes(dirs) {
  /** @type {Probe[]} */
  const probes = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const seen = new Map();

  for (const [rawDirectory, origin] of dirs) {
    const directory = purePath(rawDirectory);

    if (!existsSync(directory)) {
      continue;
    }

    for (const path of rglobSorted(directory, '.css')) {
      const probe = loadOne(path, origin, problems);

      if (!probe) {
        continue;
      }

      if (seen.has(probe.id)) {
        problems.push(`${path}: duplicate id ${probe.id} (also ${seen.get(probe.id)})`);
        continue;
      }

      seen.set(probe.id, path);
      probes.push(probe);
    }
  }

  return { probes: pySorted(probes, (probe) => probe.id), problems };
}

/**
 * Parse one file; record why it is not usable.
 *
 * @param {string} path
 * @param {string} origin
 * @param {string[]} problems
 * @returns {Probe | null}
 */
function loadOne(path, origin, problems) {
  let probe;

  try {
    probe = parseProbe(path, origin);
  } catch (error) {
    if (!(error instanceof LcrError)) {
      throw error;
    }

    problems.push(error.message);

    return null;
  }

  if (probe.errors.length) {
    problems.push(`${path}: ${probe.errors.join('; ')}`);

    return null;
  }

  return probe;
}

/**
 * The curated probe corpus shipped with the skill.
 *
 * @returns {ProbeDir[]}
 */
export function curatedDirs() {
  return [[join(SKILL_DIR, 'corpus', 'probes'), 'curated']];
}

/**
 * The PR probes an agent wrote for one run.
 *
 * @param {string} runDir
 * @returns {ProbeDir}
 */
export function prProbeDir(runDir) {
  return [joinPath(purePath(runDir), 'probes'), 'pr'];
}

/**
 * `lcr validate-probes [paths…]`: print every problem and warning and a per-area count.
 *
 * @param {readonly string[]} paths Probe directories (default: the curated corpus).
 * @returns {number} Exit status: 1 when any probe is invalid.
 */
export function validateCli(paths) {
  /** @type {ProbeDir[]} */
  const dirs = paths.length ? paths.map((path) => [path, 'cli']) : curatedDirs();
  const { probes, problems } = loadProbes(dirs);
  const warnings = probes.flatMap((probe) =>
    probe.warnings.map((warning) => `warning: ${probe.path}: ${warning}`),
  );

  for (const line of [...problems, ...warnings]) {
    print(line);
  }

  const warningCount = warnings.length ? `, ${warnings.length} warnings` : '';

  print(`${probes.length} valid probes, ${problems.length} problems${warningCount}`);

  /** @type {Map<string, number>} */
  const byArea = new Map();

  for (const probe of probes) {
    byArea.set(probe.area, (byArea.get(probe.area) ?? 0) + 1);
  }

  for (const [area, count] of pySorted(byArea, ([name]) => name)) {
    print(`  ${area}: ${count}`);
  }

  return problems.length ? 1 : 0;
}
