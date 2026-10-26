import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assessProbe,
  classifyTuple,
  countBySource,
  emptyTupleReport,
  fillIdempotent,
  flagOnly,
  mergeFlagOnly,
  pairKey,
  probeEntry,
  recordCrashes,
  rejectedTuples,
  sameJson,
  sortUnmappable,
} from '../assess.js';

/** @import { AdapterResponse, CorpusCase, ProbeResult } from '../../types.js' */
/** @import { TupleCase } from '../sources.js' */

/**
 * @param {string[]} expect
 * @returns {any}
 */
function probeCase(expect) {
  return {
    id: 'p-a/x',
    source: 'probe',
    origin: 'pr',
    probe: { id: 'a/x', known: 'none', expect },
    request: { kind: 'sheet' },
  };
}

/** @type {(responses: Record<string, Partial<AdapterResponse>>) => Record<string, AdapterResponse>} */
const outputs = (responses) => /** @type {Record<string, AdapterResponse>} */ (responses);

describe('rejected and unmappable tuples (py-final TupleFlagsTest)', () => {
  test('rejected tuples are unmappable with the reason', () => {
    const cases = /** @type {CorpusCase[]} */ (
      /** @type {unknown} */ ([
        { id: 't-a', source: 'tuple', side: 'head', helper: 'h', test: 'x::test_f', line: 3, in_diff: true },
        { id: 't-b', source: 'tuple', side: 'both', helper: 'h', test: 'x::test_g', line: 9, in_diff: false },
        { id: 't-c', source: 'tuple', side: 'base', helper: 'h', test: 'x::test_h', line: 1, in_diff: false },
      ])
    );
    const head = outputs({
      't-a': { ok: false, stage: 'request', error: 'unknown parser flag custom-functions' },
      't-b': { ok: true, code: '' },
      't-c': { ok: false, stage: 'request', error: 'x' },
    });
    const [row, ...rest] = rejectedTuples(cases, head);

    assert.deepEqual(rest, []);
    assert.equal(row.id, 't-a');
    assert.equal(row.in_diff, true);
    assert.ok(row.reason.includes('unknown parser flag custom-functions'));

    const rows = sortUnmappable([{ ...row, in_diff: false }, row, row]);

    assert.deepEqual(
      rows.map((merged) => [merged.in_diff, merged.count]),
      [
        [true, 2],
        [false, 1],
      ],
    );
  });

  test('unmappable rows sort by test, line (missing = 0), helper, id, reason, side', () => {
    const base = { helper: 'h', in_diff: false, reason: 'r', side: /** @type {const} */ ('head') };
    const rows = sortUnmappable([
      { ...base, test: 'b', line: 1 },
      { ...base, test: 'a', line: 5 },
      { ...base, test: 'a', line: /** @type {number} */ (/** @type {unknown} */ (null)) },
      { ...base, test: 'a', line: 0 },
    ]);

    assert.deepEqual(
      rows.map((row) => [row.test, row.line, row.count]),
      [
        ['a', null, 2],
        ['a', 5, 1],
        ['b', 1, 1],
      ],
    );
  });
});

describe('flag-only cases (py-final FlagOnlyTest)', () => {
  test('flagOnly lists the cases base cannot run', () => {
    const cases = /** @type {CorpusCase[]} */ (
      /** @type {unknown} */ (['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })))
    );
    const base = outputs({
      a: { stage: 'request', error: 'unknown parser flag custom-functions' },
      b: { stage: 'request', error: 'unknown parser flag custom-functions' },
      c: { stage: 'parse' },
      d: { stage: 'request', error: 'unknown parser flag x' },
      e: { stage: 'request', error: /** @type {string} */ (/** @type {unknown} */ (null)) },
    });
    const head = outputs({
      a: { ok: true },
      b: { ok: false, stage: 'parse' },
      c: { ok: true },
      d: { stage: 'request', error: 'unknown parser flag x' },
      e: { ok: true },
    });

    assert.deepEqual(flagOnly(cases, base, head), { 'custom-functions': ['a', 'b'], 'request error': ['e'] });
  });

  test('mergeFlagOnly drops re-run ids from the stored map only', () => {
    assert.deepEqual(mergeFlagOnly({ f: ['a', 'z'] }, { f: ['b'] }, new Set(['a'])), { f: ['b', 'z'] });
    assert.deepEqual(mergeFlagOnly({ g: ['a'] }, { f: ['a'] }, new Set(['a'])), { f: ['a'] });
  });
});

describe('probe assertions', () => {
  test('every assertion kind on both sides', () => {
    const corpusCase = probeCase([
      'no-panic',
      'parse-error',
      'output-contains:"a\\nb"',
      'output-not-contains:"zz"',
      'output-equals:" x "',
      'equivalent',
      'idempotent',
    ]);
    const result = assessProbe(
      corpusCase,
      { ok: true, code: 'a\nb' },
      { ok: false, stage: 'parse', error: 'e' },
    );

    assert.deepEqual(result, {
      base: {
        'no-panic': true,
        'parse-error': false,
        'output-contains:"a\\nb"': true,
        'output-not-contains:"zz"': true,
        'output-equals:" x "': false,
        equivalent: null,
        idempotent: null,
      },
      head: {
        'no-panic': true,
        'parse-error': true,
        'output-contains:"a\\nb"': false,
        'output-not-contains:"zz"': false,
        'output-equals:" x "': false,
        equivalent: null,
        idempotent: null,
      },
    });
  });

  test('escapes decode like Python unicode_escape (UTF-8 bytes read as Latin-1)', () => {
    const accented = String.fromCodePoint(0xe9);
    const corpusCase = probeCase([`output-contains:"${accented}\\t"`, 'output-equals:x']);
    const mojibake = `${String.fromCodePoint(0xc3, 0xa9)}\t`;

    assert.deepEqual(assessProbe(corpusCase, { ok: true, code: mojibake }, { ok: true, code: 'x' }), {
      base: { [`output-contains:"${accented}\\t"`]: true, 'output-equals:x': false },
      head: { [`output-contains:"${accented}\\t"`]: false, 'output-equals:x': true },
    });
  });

  test('probeEntry records crashes per side', () => {
    const entry = probeEntry(
      probeCase(['no-panic']),
      { ok: false, stage: 'timeout' },
      { ok: true, code: '' },
      true,
    );

    assert.deepEqual(entry, {
      id: 'p-a/x',
      probe: 'a/x',
      origin: 'pr',
      known: 'none',
      repro: null,
      changed: true,
      assert: { base: { 'no-panic': false }, head: { 'no-panic': true } },
      crash: { base: 'timeout' },
    });
  });

  test('fillIdempotent fills only the idempotent assertions (py-final IdempotencyTest)', () => {
    /** @type {ProbeResult} */
    const entry = /** @type {any} */ ({
      id: 'p-a',
      assert: { base: { idempotent: null, equivalent: null }, head: { idempotent: null, equivalent: null } },
    });

    fillIdempotent(
      [entry],
      { 'p-a': { stable: false, second: null } },
      { 'p-a': { stable: true, second: null } },
    );
    assert.deepEqual(entry.assert.head, { idempotent: false, equivalent: null });
    assert.equal(entry.assert.base.idempotent, true);

    fillIdempotent([entry], {}, {});
    assert.equal(entry.assert.head.idempotent, null, 'no second pass: undecided');
  });
});

describe('robustness, deltas and counts', () => {
  test('crash stages become robustness rows with the error cut to 300 characters', () => {
    const robustness = { base: [], head: [] };
    const corpusCase = /** @type {CorpusCase} */ (/** @type {unknown} */ ({ id: 'x', source: 'wpt' }));

    recordCrashes(corpusCase, { stage: 'panic', error: 'e'.repeat(400) }, { stage: 'parse' }, robustness);
    assert.deepEqual(robustness, {
      base: [{ id: 'x', source: 'wpt', stage: 'panic', error: 'e'.repeat(300) }],
      head: [],
    });
  });

  test('sameJson ignores key order', () => {
    assert.ok(sameJson({ ok: true, code: 'a' }, { code: 'a', ok: true }));
    assert.ok(!sameJson({ ok: true, code: 'a' }, { ok: true, code: 'b' }));
  });

  test('countBySource keeps first-appearance order', () => {
    assert.deepEqual(Object.entries(countBySource([{ source: 'b' }, { source: 'a' }, { source: 'b' }])), [
      ['b', 2],
      ['a', 1],
    ]);
  });
});

describe('tuple buckets', () => {
  /**
   * @param {string} id
   * @param {string} side
   * @param {string} expected
   * @param {string} [helper]
   * @returns {TupleCase}
   */
  const tupleCase = (id, side, expected, helper = 'minify_test') =>
    /** @type {TupleCase} */ (
      /** @type {unknown} */ ({
        id,
        source: 'tuple',
        side,
        helper,
        test: 't',
        line: 1,
        in_diff: false,
        suffix: '',
        request: { kind: 'sheet', css: 'x', property: 'width', value: '1px' },
        expectation: { type: 'code', code: expected },
        tuple: { fields: { source: 'x', expected } },
      })
    );
  const yes = { ok: true, code: 'ok' };
  const no = { ok: true, code: 'other' };

  test('a changed expectation pairs a base-only tuple with its head-only partner', () => {
    const head = tupleCase('t-h', 'head', 'ok');
    const base = tupleCase('t-b', 'base', 'old');
    const report = emptyTupleReport();

    assert.equal(pairKey(head), pairKey(base));
    classifyTuple(base, no, yes, new Map([[pairKey(head), head]]), report);
    assert.deepEqual(report.modified, [
      { id: 't-b', helper: 'minify_test', test: 't', line: 1, in_diff: false, head_id: 't-h', head_line: 1 },
    ]);
  });

  test('property_range_test pairs by property and value', () => {
    const left = tupleCase('a', 'head', 'x', 'property_range_test');
    const right = tupleCase('b', 'base', 'y', 'property_range_test');

    right.tuple.fields = { other: 1 };
    assert.equal(pairKey(left), pairKey(right));
  });

  test('every bucket', () => {
    const report = emptyTupleReport();
    const none = new Map();

    classifyTuple(tupleCase('both-head-fails', 'both', 'ok'), yes, no, none, report);
    classifyTuple(tupleCase('both-base-fails', 'both', 'ok'), no, yes, none, report);
    classifyTuple(tupleCase('new-failing', 'head', 'ok'), no, yes, none, report);
    classifyTuple(tupleCase('new-passing', 'head', 'ok'), yes, yes, none, report);
    classifyTuple(tupleCase('removed-changed', 'base', 'ok'), yes, no, none, report);
    classifyTuple(tupleCase('removed-same', 'base', 'ok'), yes, yes, none, report);
    classifyTuple(
      tupleCase('head-error', 'head', 'ok'),
      yes,
      { ok: false, code: '', error: 'boom' },
      none,
      report,
    );

    assert.deepEqual(
      Object.fromEntries(Object.entries(report).map(([bucket, rows]) => [bucket, rows.map((row) => row.id)])),
      {
        head_mismatch: ['both-head-fails', 'head-error'],
        new_failing_on_base: ['new-failing'],
        new_passing_on_base: ['new-passing'],
        modified: [],
        removed_changed: ['removed-changed'],
        removed_same: ['removed-same'],
        base_mismatch: ['both-base-fails'],
      },
    );
    assert.equal(report.head_mismatch[0].got, 'other');
    assert.equal(report.head_mismatch[1].got, 'boom', 'an empty code falls back to the error');
  });
});
