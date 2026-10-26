import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { parseCssModulesDebug, rustUnescape } from '../rust-debug.js';
import { loadTuples, mappingProblem, matchesExpectation, toRequests, tupleIdentity } from '../tuples.js';

const BITS = { Nesting: 1, MediaRangeSyntax: 128 };
const ELLIPSIS = String.fromCodePoint(0x2026);

test('prefix_test maps to a sheet request with its browsers', () => {
  const tuple = {
    helper: 'prefix_test',
    fields: { source: '.a{}', expected: '.a {\n}\n', targets: 'Browsers { chrome: Some(5242880) }' },
  };
  const [[, request, expectation]] = /** @type {any[]} */ (toRequests(tuple, BITS));

  assert.deepEqual(request, {
    kind: 'sheet',
    css: '.a{}',
    minify: true,
    compact: false,
    targets: { chrome: 5242880 },
  });
  assert.deepEqual(expectation, { type: 'code', code: '.a {\n}\n' });
});

test('custom_media_test prints without targets', () => {
  const [[, request]] = /** @type {any[]} */ (
    toRequests({ helper: 'custom_media_test', fields: { source: 'x', expected: 'y' } }, BITS)
  );

  assert.deepEqual(request.targets, { chrome: 95 << 16 });
  assert.equal(request.printer_targets, null);
  assert.deepEqual(request.flags, ['custom-media']);
});

test('an empty css_modules filename stays empty and the default pattern is left out', () => {
  const options = {
    flags: 'ParserFlags(0x0)',
    css_modules:
      'Some(Config { pattern: Pattern { segments: [Hash, Literal("_"), Local] }, dashed_idents: false, animation: true, grid: true, custom_idents: true, container: true, pure: true })',
    error_recovery: false,
    filename: '',
  };
  const tuple = {
    helper: 'minify_test_with_options_and_browsers',
    fields: { source: ':local(.a){}', expected: 'x', options, browsers: 'None' },
  };
  const [[, request]] = /** @type {any[]} */ (toRequests(tuple, BITS));

  assert.equal(request.filename, '');
  assert.equal(request.css_modules.pure, true);
  assert.ok(!('pattern' in request.css_modules));
});

test('property_range_test expands into one value request per (property, case)', () => {
  const tuple = {
    helper: 'property_range_test',
    fields: {
      names: '["width", "height"]',
      cases: '[("-1px", None), ("calc(1px - 2px)", Some("0")), ("a\\"b", None)]',
    },
  };
  const requests = /** @type {any[]} */ (toRequests(tuple, BITS));

  assert.equal(requests.length, 6);
  assert.deepEqual(requests[1][1], {
    kind: 'value',
    property: 'width',
    value: 'calc(1px - 2px)',
    compact: true,
  });
  assert.deepEqual(requests[1][2], { type: 'value', code: '0' });
  assert.deepEqual(requests[0][2], { type: 'value-unparsed' });
  assert.equal(requests[2][1].value, 'a"b');
});

test('matchesExpectation', () => {
  assert.equal(matchesExpectation({ type: 'code', code: 'x' }, { ok: true, code: 'x' }), true);
  assert.equal(
    matchesExpectation({ type: 'value', code: '0' }, { ok: true, code: '0', recognition: 'unparsed' }),
    false,
  );
  assert.equal(
    matchesExpectation(
      { type: 'error', stage: 'parse', error: 'UnexpectedToken(Ident("x"))' },
      { ok: false, stage: 'parse', error: `${ELLIPSIS} | UnexpectedToken(${ELLIPSIS})` },
    ),
    true,
  );
  assert.equal(matchesExpectation({ type: 'warnings' }, { ok: true }), null);
});

test('rustUnescape', () => {
  assert.equal(rustUnescape(String.raw`a\u{1f600}\n\\`), `a${String.fromCodePoint(0x1f600)}\n\\`);

  for (const [escaped, expected] of buildGolden().rust_unescape) {
    assert.equal(rustUnescape(escaped), expected);
  }
});

test('unknown parser flags pass through, kebab-cased', () => {
  const tuple = {
    helper: 'minify_test_with_options_and_browsers',
    fields: {
      source: '@function --f() {}',
      expected: 'x',
      browsers: 'None',
      options: { flags: 'ParserFlags(NESTING | CUSTOM_FUNCTIONS)' },
    },
  };
  const [[, request]] = /** @type {any[]} */ (toRequests(tuple, {}));

  assert.deepEqual(request.flags, ['custom-functions', 'nesting']);
});

test('mappingProblem names the reason', () => {
  assert.match(mappingProblem({ helper: 'nope' }), /no adapter mapping/);
  assert.equal(toRequests({ helper: 'nope', fields: {} }, {}), null);
});

test('every helper maps as py-final maps it (requests, expectations, problems, identities)', () => {
  for (const { tuple, bits, requests, problem, identity } of buildGolden().to_requests) {
    const label = `${tuple.helper} ${JSON.stringify(tuple.fields).slice(0, 80)}`;

    assert.equal(asPythonJson(toRequests(tuple, bits)), asPythonJson(requests), label);
    assert.equal(mappingProblem(tuple), problem, label);
    assert.equal(tupleIdentity(tuple), identity, label);
  }
});

test('parseCssModulesDebug reads the Debug form of css_modules::Config', () => {
  for (const [text, expected] of buildGolden().css_modules_debug) {
    assert.equal(asPythonJson(parseCssModulesDebug(text)), asPythonJson(expected), String(text));
  }
});

test('loadTuples keeps the first occurrence of each call and counts repeats', () => {
  using dir = tempDir();
  const row = (/** @type {number} */ line, /** @type {string} */ source) => ({
    test: 'tests::test_a',
    helper: 'prefix_test',
    file: 'src/lib.rs',
    line,
    fields: { source },
  });

  writeFiles(dir.path, { 'tuples.jsonl': [row(1, 'a'), row(2, 'b'), row(3, 'a')] });

  const tuples = loadTuples(join(dir.path, 'tuples.jsonl'));
  const first = /** @type {any} */ (tuples.get(tupleIdentity(row(9, 'a'))));

  assert.equal(tuples.size, 2);
  assert.equal(first.line, 1);
  assert.equal(first.count, 2);
  assert.equal(loadTuples(join(dir.path, 'missing.jsonl')).size, 0);
});
