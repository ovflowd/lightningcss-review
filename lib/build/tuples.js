/**
 * Test tuples recorded from the Lightning CSS test helpers, mapped to adapter requests.
 *
 * Stage: build writes them (build/<side>/tuples.jsonl, one row per helper call); corpus turns them
 * into cases and report shows base tuples as evidence. Each helper call (`prefix_test(source,
 * expected, targets)`, …) becomes one tuple. Mapping a tuple to adapter requests reproduces
 * exactly what the helper does to Lightning CSS (parse options, minify, printer targets), so the
 * head expectations can run on the base build and vice versa without compiling one side's tests
 * against the other side's code. `property_range_test` expands into one request per
 * (property, value).
 *
 * Invariants: the mapping is a pure function of the tuple and that side's `Features` bits; the
 * request key order follows py-final's (it is not hashed, but it is what the adapter receives).
 */
import { iterJsonl } from '../core/files.js';
import { stableId } from '../core/ids.js';
import { pyRe } from '../core/py-re.js';
import { compareCodePoints, pyStrip, pyTruthy } from '../core/py.js';
import { parseBrowsersDebug, parseFlagsDebug, parseTargetsDebug } from '../targets/targets.js';
import { parseCssModulesDebug, RUST_STR, rustUnescape } from './rust-debug.js';

/** @import { AdapterRequest, AdapterResponse, Targets, TupleExpectation, TupleRecord } from '../types.js' */

/**
 * How one helper drives Lightning CSS.
 *
 * @typedef {object} HelperSpec
 * @property {'attr'} [kind] Request kind when not `sheet`.
 * @property {boolean} [minify]
 * @property {boolean | string} [compact] A constant, the name of a bool field, or `options.minify`.
 * @property {null | Targets | string} [targets] None, constant targets, the field holding the
 *   `Browsers` Debug text, or `targets:Targets` for a `Targets` Debug field.
 * @property {null | string} [printer_targets] Present when the printer gets its own targets
 *   (`options.targets`), or none.
 * @property {string[]} [flags] Parser flags the helper always sets.
 * @property {'parse' | 'minify'} [expect_error] The helper asserts an error at this stage.
 * @property {'config' | 'default'} [css_modules]
 * @property {boolean} [error_recovery]
 * @property {boolean} [warnings_only] Only warnings are asserted; there is no code to compare.
 * @property {'range'} [expand]
 */

/** The printer targets of `custom_media_test` (Chrome 95, encoded `major << 16`). */
const CHROME_95 = Object.freeze({ chrome: 95 << 16 });

/**
 * Helper name -> how it drives Lightning CSS, read off the helper bodies in src/lib.rs.
 *
 * @type {Readonly<Record<string, HelperSpec>>}
 */
export const HELPERS = Object.freeze({
  test_with_options: { minify: true, compact: false, targets: null },
  test_with_printer_options: {
    minify: true,
    compact: 'options.minify',
    targets: null,
    printer_targets: 'options.targets',
  },
  minify_test_with_options_and_browsers: { minify: true, compact: true, targets: 'browsers' },
  prefix_test: { minify: true, compact: false, targets: 'targets' },
  attr_test: { kind: 'attr', minify: true, compact: 'minify', targets: 'targets' },
  nesting_test_with_targets: { minify: true, compact: false, targets: 'targets:Targets' },
  nesting_test_no_targets: { minify: true, compact: false, targets: null },
  custom_media_test: {
    minify: true,
    compact: false,
    targets: CHROME_95,
    printer_targets: null,
    flags: ['custom-media'],
  },
  css_modules_test: { minify: true, compact: 'minify', targets: null, css_modules: 'config' },
  error_test: { expect_error: 'parse' },
  error_test_with_options: { expect_error: 'parse' },
  css_modules_error_test: { expect_error: 'parse', css_modules: 'default' },
  minify_error_test_with_options: { expect_error: 'minify' },
  error_recovery_test: {
    minify: false,
    compact: false,
    targets: null,
    error_recovery: true,
    warnings_only: true,
  },
  property_range_test: { expand: 'range' },
});

/** `ParserFlags` constant -> the adapter's flag name, where it is not the kebab-cased constant. */
const PARSER_FLAG_NAMES = new Map([
  ['NESTING', 'nesting'],
  ['CUSTOM_MEDIA', 'custom-media'],
  ['DEEP_SELECTOR_COMBINATOR', 'deep-selector-combinator'],
  ['SCROLL_NAVIGATION_CONTROLS', 'scroll-navigation-controls'],
]);

/**
 * `ParserFlags::CUSTOM_FUNCTIONS` -> `custom-functions`, as the adapter's `ParserFlags::from_name`
 * spells it. Unknown flags pass through, so the adapter of a side that lacks one rejects the
 * request and the tuple is reported unmappable with that reason.
 *
 * @param {string} name
 * @returns {string}
 */
export function parserFlagName(name) {
  return PARSER_FLAG_NAMES.get(name) ?? name.toLowerCase().replaceAll('_', '-');
}

/**
 * The identity of a recorded call: the helper and its arguments (not the test or the line), so
 * the same expectation recorded on base and head pairs up.
 *
 * @param {Pick<TupleRecord, 'helper' | 'fields'>} tuple
 * @returns {string}
 */
export function tupleIdentity(tuple) {
  return stableId(tuple.helper, tuple.fields);
}

/**
 * @typedef {TupleRecord & { identity: string, count: number }} LoadedTuple
 */

/**
 * Every recorded tuple of a tuples.jsonl by identity: the first occurrence, with `count` of how
 * often the same call was recorded.
 *
 * @param {string} path
 * @returns {Map<string, LoadedTuple>}
 */
export function loadTuples(path) {
  /** @type {Map<string, LoadedTuple>} */
  const tuples = new Map();

  for (const row of iterJsonl(path)) {
    const tuple = /** @type {TupleRecord} */ (row);
    const identity = tupleIdentity(tuple);
    const seen = tuples.get(identity);

    if (seen) {
      seen.count++;
    } else {
      tuples.set(identity, { ...tuple, identity, count: 1 });
    }
  }

  return tuples;
}

/** @typedef {[suffix: string, request: AdapterRequest, expectation: TupleExpectation]} TupleRequest */

/**
 * `[suffix, adapter request, expectation]` triples that reproduce one recorded helper call (one
 * per (property, value) for `property_range_test`), or null when the helper has no mapping.
 *
 * @param {Pick<TupleRecord, 'helper' | 'fields'>} tuple
 * @param {Record<string, number>} bits That side's `Features` bits (targets.featureBits).
 * @returns {TupleRequest[] | null}
 */
export function toRequests(tuple, bits) {
  const spec = Object.hasOwn(HELPERS, tuple.helper) ? HELPERS[tuple.helper] : null;
  const fields = tuple.fields;

  if (!spec) {
    return null;
  }

  if (spec.expand === 'range') {
    return rangeRequests(fields);
  }

  if (!Object.hasOwn(fields, 'source')) {
    return null;
  }

  /** @type {AdapterRequest} */
  const request = { kind: spec.kind ?? 'sheet', css: /** @type {string} */ (fields.source) };
  /** @type {TupleExpectation} */
  let expectation;

  if (spec.expect_error) {
    Object.assign(request, { minify: spec.expect_error === 'minify', compact: false, targets: null });
    expectation = { type: 'error', stage: spec.expect_error, error: stringOrNull(fields.error) };
  } else {
    addPrintOptions(request, spec, fields, bits);
    expectation = spec.warnings_only
      ? { type: 'warnings' }
      : { type: 'code', code: stringOrNull(fields.expected) };
  }

  addParserOptions(request, spec, fields);

  return [['', request, expectation]];
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return /** @type {string | null} */ (value ?? null);
}

/**
 * `options` when it is a recorded, non-empty object (ParserOptions or PrinterOptions), else null.
 *
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown> | null}
 */
function recordedOptions(fields) {
  const options = fields.options;
  const isObject = typeof options === 'object' && options !== null && !Array.isArray(options);

  return isObject && pyTruthy(options) ? /** @type {Record<string, unknown>} */ (options) : null;
}

/**
 * The recorded options, or an empty object when they are absent or empty.
 *
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
function optionsOrEmpty(fields) {
  return pyTruthy(fields.options) ? /** @type {Record<string, unknown>} */ (fields.options) : {};
}

/**
 * minify, compact, targets (with include/exclude) and printer targets, as the helper sets them.
 *
 * @param {AdapterRequest} request
 * @param {HelperSpec} spec
 * @param {Record<string, unknown>} fields
 * @param {Record<string, number>} bits
 * @returns {void}
 */
function addPrintOptions(request, spec, fields, bits) {
  request.minify = /** @type {boolean} */ (spec.minify);
  request.compact = compactFor(spec.compact, fields);
  addTargets(request, spec.targets ?? null, fields, bits);

  if (Object.hasOwn(spec, 'printer_targets')) {
    if (spec.printer_targets === null) {
      request.printer_targets = null;
    } else {
      const parsed = parseTargetsDebug(debugText(optionsOrEmpty(fields).targets), bits);

      request.printer_targets = {
        browsers: parsed.targets,
        include: parsed.include,
        exclude: parsed.exclude,
      };
    }
  }
}

/**
 * @param {HelperSpec['compact']} compact
 * @param {Record<string, unknown>} fields
 * @returns {boolean}
 */
function compactFor(compact, fields) {
  if (compact === 'options.minify') {
    return pyTruthy(optionsOrEmpty(fields).minify);
  }

  if (typeof compact === 'string') {
    return pyTruthy(fields[compact]);
  }

  return pyTruthy(compact);
}

/**
 * @param {AdapterRequest} request
 * @param {null | Targets | string} targets
 * @param {Record<string, unknown>} fields
 * @param {Record<string, number>} bits
 * @returns {void}
 */
function addTargets(request, targets, fields, bits) {
  if (targets === null) {
    request.targets = null;
  } else if (typeof targets === 'object') {
    request.targets = { ...targets };
  } else if (targets === 'targets:Targets') {
    const parsed = parseTargetsDebug(debugText(fields.targets), bits);

    request.targets = parsed.targets;

    if (parsed.include) {
      request.include = parsed.include;
    }

    if (parsed.exclude) {
      request.exclude = parsed.exclude;
    }
  } else {
    request.targets = parseBrowsersDebug(debugText(fields[targets]));
  }
}

/**
 * @param {unknown} value
 * @returns {string | null | undefined}
 */
function debugText(value) {
  return /** @type {string | null | undefined} */ (value);
}

/**
 * Parser flags, error recovery, CSS modules and filename: from the helper itself and from the
 * recorded `ParserOptions`.
 *
 * @param {AdapterRequest} request
 * @param {HelperSpec} spec
 * @param {Record<string, unknown>} fields
 * @returns {void}
 */
function addParserOptions(request, spec, fields) {
  const options = recordedOptions(fields);
  const flags = [...(spec.flags ?? [])];

  if (options && Object.hasOwn(options, 'flags')) {
    for (const name of parseFlagsDebug(debugText(options.flags))) {
      flags.push(parserFlagName(name));
    }
  }

  if (flags.length > 0) {
    request.flags = [...new Set(flags)].sort(compareCodePoints);
  }

  if (options) {
    addRecordedParserOptions(request, options);
  }

  if (spec.error_recovery) {
    request.error_recovery = true;
  }

  if (spec.css_modules === 'config') {
    request.css_modules = parseCssModulesDebug(fields.config) ?? {};
    request.filename = 'test.css';
  } else if (spec.css_modules === 'default') {
    request.css_modules = {};
  }
}

/**
 * @param {AdapterRequest} request
 * @param {Record<string, unknown>} options
 * @returns {void}
 */
function addRecordedParserOptions(request, options) {
  if (pyTruthy(options.error_recovery)) {
    request.error_recovery = true;
  }

  const cssModules = parseCssModulesDebug(options.css_modules);

  if (cssModules !== null) {
    request.css_modules = cssModules;
  }

  if (Object.hasOwn(options, 'filename')) {
    request.filename = /** @type {string} */ (options.filename);
  }
}

const RANGE_CASE = pyRe(String.raw`\(${RUST_STR}, (None|Some\(${RUST_STR}\))\)`, 'g');
const RUST_STR_ALL = pyRe(RUST_STR, 'g');

/**
 * `property_range_test(names, cases)`: every property name with every `(value, expected)` case,
 * read from the Debug text of the two slices. Null when either cannot be parsed.
 *
 * @param {Record<string, unknown>} fields
 * @returns {TupleRequest[] | null}
 */
function rangeRequests(fields) {
  const namesText = pyTruthy(fields.names) ? String(fields.names) : '';
  const casesText = pyTruthy(fields.cases) ? String(fields.cases) : '';
  const names = Array.from(namesText.matchAll(RUST_STR_ALL), (match) => rustUnescape(match[1]));
  const cases = Array.from(casesText.matchAll(RANGE_CASE), (match) => ({
    value: match[1],
    unparsed: match[2] === 'None',
    expected: match[3] ?? '',
  }));

  if (names.length === 0 || cases.length === 0) {
    return null;
  }

  return names.flatMap((name) =>
    cases.map(({ value, unparsed, expected }) => {
      /** @type {AdapterRequest} */
      const request = { kind: 'value', property: name, value: rustUnescape(value), compact: true };
      /** @type {TupleExpectation} */
      const expectation = unparsed
        ? { type: 'value-unparsed' }
        : { type: 'value', code: rustUnescape(expected) };

      // The suffix hashes the escaped value text, as recorded.
      return /** @type {TupleRequest} */ ([stableId(name, value), request, expectation]);
    }),
  );
}

/**
 * Why `toRequests` returned null for this tuple.
 *
 * @param {Pick<TupleRecord, 'helper'>} tuple
 * @returns {string}
 */
export function mappingProblem(tuple) {
  if (!Object.hasOwn(HELPERS, tuple.helper)) {
    return `helper ${tuple.helper} has no adapter mapping`;
  }

  if (HELPERS[tuple.helper].expand === 'range') {
    return 'property_range_test names/cases not parseable';
  }

  return 'no source field recorded';
}

/**
 * Whether an adapter response meets a tuple's recorded expectation; null for expectation types
 * that are not checked here (`warnings`).
 *
 * @param {TupleExpectation} expectation
 * @param {Partial<AdapterResponse>} response
 * @returns {boolean | null}
 */
export function matchesExpectation(expectation, response) {
  const ok = Boolean(response.ok);
  const code = response.code ?? null;

  switch (expectation.type) {
    case 'code':
      return ok && code === (expectation.code ?? null);
    case 'value':
      return (
        ok &&
        response.recognition !== 'unparsed' &&
        response.recognition !== 'custom' &&
        code === expectation.code
      );
    case 'value-unparsed':
      return ok && response.recognition === 'unparsed';
    case 'error':
      return matchesError(expectation, response);
    default:
      return null;
  }
}

/**
 * An expected error: same failing stage, and the expected error's kind (the text before its
 * first `(`) appears in the actual error.
 *
 * @param {{ stage: string, error: string | null }} expectation
 * @param {Partial<AdapterResponse>} response
 * @returns {boolean}
 */
function matchesError(expectation, response) {
  if (response.ok || response.stage !== expectation.stage) {
    return false;
  }

  const wanted = pyStrip((expectation.error || '').split('(')[0]);

  return wanted ? (response.error || '').includes(wanted) : true;
}
